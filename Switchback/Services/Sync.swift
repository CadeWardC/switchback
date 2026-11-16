import CryptoKit
import Foundation

/// The server collections the app uses, and what their documents look like.
///
/// - `saved_trails`: one document per saved trail, `{v, trail, saved_at}` where `trail` is the trail as the app
///   stores it (lines as encoded polylines) and `saved_at` is milliseconds since 1970.
/// - `activities`: one document per recorded hike (id = the hike's UUID), see `ActivityDoc`.
/// - `submissions`: hikes sent in for review (written once, then only the reviewer changes `status`).
/// Settings, caches, offline maps and trail packs stay on the phone.
enum SyncCollection: String, Codable, CaseIterable {
    case savedTrails = "saved_trails"
    case activities

    static let submissions = "submissions"
}

enum SyncIDs {
    /// Trail ids can hold characters the server doesn't allow in ids ("u123|456"), so those are hashed.
    static func trail(_ id: String) -> String {
        let plain = "t." + id
        if ServerClient.isValidName(plain) { return plain }
        let digest = SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined()
        return "h." + digest
    }

    static func activity(_ id: UUID) -> String { id.uuidString.lowercased() }
}

private func ms(_ d: Date) -> Int64 { Int64((d.timeIntervalSince1970 * 1000).rounded()) }
private func date(_ ms: Int64) -> Date { Date(timeIntervalSince1970: Double(ms) / 1000) }

struct SavedTrailDoc: Codable {
    var v = 1
    var trail: Trail
    var saved_at: Int64
}

/// A recorded hike, compact: each segment's line as a 1e-6° polyline, altitudes to 0.1 m, and times as seconds
/// after the start (0.1 s). Dates are milliseconds since 1970.
struct ActivityDoc: Codable {
    struct Segment: Codable {
        var line: String
        var alt: [Double?]
        var t: [Double]
    }

    struct Point: Codable {
        var id: String
        var kind: String
        var note: String
        var lat: Double
        var lon: Double
        var time: Int64
    }

    var v = 1
    var id: String
    var name: String
    var start: Int64
    var end: Int64
    var distance: Double
    var moving_time: Double
    var elapsed_time: Double
    var gain: Double
    var trail_id: String?
    var trail_name: String?
    var segments: [Segment]
    var points: [Point]?
    var submission_id: String?

    init(_ a: Activity) {
        id = a.id.uuidString
        name = a.name
        start = ms(a.start)
        end = ms(a.end)
        distance = (a.distance * 10).rounded() / 10
        moving_time = a.movingTime.rounded()
        elapsed_time = a.elapsedTime.rounded()
        gain = (a.gain * 10).rounded() / 10
        trail_id = a.trailId
        trail_name = a.trailName
        let t0 = a.start
        segments = a.segments.map { seg in
            Segment(line: Polyline.encodeTrack(seg.map(\.coord)),
                    alt: seg.map { $0.alt.map { ($0 * 10).rounded() / 10 } },
                    t: seg.map { ($0.time.timeIntervalSince(t0) * 10).rounded() / 10 })
        }
        points = a.points.map { $0.map { p in
            Point(id: p.id.uuidString, kind: p.kind.rawValue, note: p.note, lat: p.lat, lon: p.lon, time: ms(p.time))
        } }
        submission_id = a.submissionId
    }

    var activity: Activity? {
        guard let uuid = UUID(uuidString: id) else { return nil }
        let t0 = date(start)
        let segs: [[TrackPoint]] = segments.map { s in
            let coords = Polyline.decodeTrack(s.line)
            return coords.indices.map { i in
                TrackPoint(lat: coords[i].lat, lon: coords[i].lon,
                           alt: i < s.alt.count ? s.alt[i] : nil,
                           time: t0.addingTimeInterval(i < s.t.count ? s.t[i] : 0))
            }
        }
        let pts = points?.compactMap { p -> HikePoint? in
            guard let pid = UUID(uuidString: p.id) else { return nil }
            return HikePoint(id: pid, kind: HikePoint.Kind(rawValue: p.kind) ?? .other, note: p.note,
                             lat: p.lat, lon: p.lon, time: date(p.time))
        }
        return Activity(id: uuid, name: name, start: t0, end: date(end), segments: segs, distance: distance,
                        movingTime: moving_time, elapsedTime: elapsed_time, gain: gain, trailId: trail_id,
                        trailName: trail_name, points: pts, submissionId: submission_id)
    }
}

/// A hike sent in to be checked. `status` starts as "pending"; the reviewer sets "approved" or "rejected".
struct SubmissionDoc: Codable {
    struct Review: Codable {
        var rating: Int?
        var text: String
    }

    var v = 1
    var status = "pending"
    var submitted_at: Int64
    var name: String
    var review: Review?
    /// The hiker agreed that what they submit may be shown publicly, and that photos are for public use.
    var public_use_consent: Bool
    var app_version: String?
    var hike: ActivityDoc
    var reviewed_at: Int64?
    var reviewer_note: String?
}

/// Keeps saved trails and hikes in step with the server. Everything works locally first; changes are queued and
/// sent when the server is reachable, then the `since` feed of each collection brings in other devices' changes.
@MainActor
final class SyncEngine: ObservableObject {
    static let shared = SyncEngine()

    @Published private(set) var isSyncing = false
    @Published private(set) var lastSync: Date?
    @Published private(set) var lastError: String?
    @Published private(set) var isOffline = false
    @Published private(set) var pendingCount = 0

    private struct Pending: Codable, Hashable {
        var collection: SyncCollection
        var docId: String
        /// The trail id or hike UUID on the phone.
        var localId: String
        var delete: Bool
        /// Tells two changes to the same item apart, so one made while the other is uploading isn't dropped.
        var seq: Int = 0
    }

    private struct State: Codable {
        var fingerprint = ""
        var since: [String: Int64] = [:]
        var pending: [Pending] = []
        var lastSync: Date?
        var seq = 0
    }

    private var state: State
    private let url = Files.support.appendingPathComponent("sync-state.json")
    private var soon: Task<Void, Never>?
    private var running: Task<Void, Never>?
    private var again = false

    init() {
        state = Files.load(State.self, from: url) ?? State()
        lastSync = state.lastSync
        pendingCount = state.pending.count
    }

    var isActive: Bool { ServerConfig.isEnabled && ServerConfig.isConfigured }

    // MARK: Changes from the phone

    func trailChanged(_ id: String, deleted: Bool = false) {
        enqueue(Pending(collection: .savedTrails, docId: SyncIDs.trail(id), localId: id, delete: deleted))
    }

    func activityChanged(_ id: UUID, deleted: Bool = false) {
        enqueue(Pending(collection: .activities, docId: SyncIDs.activity(id), localId: id.uuidString, delete: deleted))
    }

    private func enqueue(_ change: Pending) {
        var p = change
        state.seq += 1
        p.seq = state.seq
        state.pending.removeAll { $0.collection == p.collection && $0.docId == p.docId }
        state.pending.append(p)
        persist()
        syncSoon()
    }

    private func enqueueQuietly(_ change: Pending) {
        var p = change
        state.seq += 1
        p.seq = state.seq
        state.pending.append(p)
    }

    /// Settings changed (server, key, on/off): the next sync starts over as a first sync.
    func configurationChanged() {
        lastError = nil
        isOffline = false
        syncSoon(after: 0)
    }

    // MARK: Running

    func syncSoon(after seconds: Double = 2) {
        soon?.cancel()
        soon = Task { [weak self] in
            if seconds > 0 { try? await Task.sleep(nanoseconds: UInt64(seconds * 1e9)) }
            guard !Task.isCancelled else { return }
            await self?.sync()
        }
    }

    /// Runs one sync, or queues one more after the current one if it's already running.
    func sync() async {
        guard isActive else {
            lastError = nil
            return
        }
        if let running {
            again = true
            await running.value
            return
        }
        let task = Task { await self.run() }
        running = task
        await task.value
        running = nil
        if again {
            again = false
            await sync()
        }
    }

    private func run() async {
        isSyncing = true
        defer { isSyncing = false }
        do {
            let client = try ServerClient.current()
            if state.fingerprint != ServerConfig.fingerprint {
                // a new server (or the very first sync): what's queued was for the old one
                state = State(fingerprint: ServerConfig.fingerprint)
                persist()
            }
            for c in SyncCollection.allCases {
                if state.since[c.rawValue] == nil {
                    try await firstSync(c, client)
                }
            }
            try await push(client)
            for c in SyncCollection.allCases {
                try await pull(c, client)
            }
            state.lastSync = Date()
            lastSync = state.lastSync
            lastError = nil
            isOffline = false
            persist()
        } catch let e as ServerError where e.isOffline {
            isOffline = true
            lastError = e.localizedDescription
        } catch {
            isOffline = false
            lastError = error.localizedDescription
        }
    }

    /// First sync of a collection: take everything the server has (it wins over the phone's copy of the same
    /// item, so a second phone can't overwrite the first), then upload what only the phone has.
    private func firstSync(_ c: SyncCollection, _ client: ServerClient) async throws {
        let library = Library.shared
        let onServer: Set<String>
        let serverTime: Int64
        switch c {
        case .savedTrails:
            let list = try await client.list(c.rawValue, as: SavedTrailDoc.self)
            for doc in list.items where !doc.deleted { applyTrail(doc) }
            onServer = Set(list.items.filter { !$0.deleted }.map(\.id))
            serverTime = list.serverTime
            for t in library.trails where !onServer.contains(SyncIDs.trail(t.id)) {
                enqueueQuietly(Pending(collection: c, docId: SyncIDs.trail(t.id), localId: t.id, delete: false))
            }
        case .activities:
            let list = try await client.list(c.rawValue, as: ActivityDoc.self)
            for doc in list.items where !doc.deleted { applyActivity(doc) }
            onServer = Set(list.items.filter { !$0.deleted }.map(\.id))
            serverTime = list.serverTime
            for a in library.activities where !onServer.contains(SyncIDs.activity(a.id)) {
                enqueueQuietly(Pending(collection: c, docId: SyncIDs.activity(a.id), localId: a.id.uuidString, delete: false))
            }
        }
        state.since[c.rawValue] = serverTime
        persist()
    }

    private func push(_ client: ServerClient) async throws {
        let library = Library.shared
        var skipped: [String] = []
        while let p = state.pending.first {
            do {
                if p.delete {
                    try await client.delete(p.collection.rawValue, p.docId)
                } else {
                    switch p.collection {
                    case .savedTrails:
                        if let t = library.trails.first(where: { $0.id == p.localId }) {
                            try await client.put(p.collection.rawValue, p.docId,
                                                 SavedTrailDoc(trail: t, saved_at: ms(library.savedAt(t.id))))
                        }
                    case .activities:
                        if let a = library.activities.first(where: { $0.id.uuidString == p.localId }) {
                            try await client.put(p.collection.rawValue, p.docId, ActivityDoc(a))
                        }
                    }
                }
            } catch ServerError.tooLarge(let n) {
                skipped.append(ServerError.tooLarge(n).localizedDescription)
            } catch ServerError.status(413, _) {
                skipped.append(ServerError.status(413, nil).localizedDescription)
            } catch ServerError.status(400, let msg) {
                skipped.append("The server turned down an item: \(msg ?? "bad request").")
            }
            // only drop it if nothing newer was queued for the same item while it was being sent
            if let i = state.pending.firstIndex(of: p) { state.pending.remove(at: i) }
            persist()
        }
        if let first = skipped.first {
            throw SyncSkipped(message: first + (skipped.count > 1 ? " (\(skipped.count) items)" : ""))
        }
    }

    private func pull(_ c: SyncCollection, _ client: ServerClient) async throws {
        // a change on the phone that hasn't been sent yet wins over the server's copy
        let waiting = Set(state.pending.filter { $0.collection == c }.map(\.docId))
        let serverTime: Int64
        switch c {
        case .savedTrails:
            let list = try await client.list(c.rawValue, as: SavedTrailDoc.self, since: state.since[c.rawValue])
            for doc in list.items where !waiting.contains(doc.id) { applyTrail(doc) }
            serverTime = list.serverTime
        case .activities:
            let list = try await client.list(c.rawValue, as: ActivityDoc.self, since: state.since[c.rawValue])
            for doc in list.items where !waiting.contains(doc.id) { applyActivity(doc) }
            serverTime = list.serverTime
        }
        state.since[c.rawValue] = serverTime
        persist()
    }

    private func applyTrail(_ doc: ServerDocument<SavedTrailDoc>) {
        if doc.deleted {
            Library.shared.applyRemoteTrailDeletion(docId: doc.id)
        } else if let d = doc.data {
            Library.shared.applyRemote(d.trail, savedAt: date(d.saved_at))
        }
    }

    private func applyActivity(_ doc: ServerDocument<ActivityDoc>) {
        if doc.deleted {
            Library.shared.applyRemoteActivityDeletion(docId: doc.id)
        } else if let a = doc.data?.activity {
            Library.shared.applyRemote(a)
        }
    }

    private func persist() {
        pendingCount = state.pending.count
        Files.save(state, to: url)
    }

    // MARK: Submissions and the connection check

    /// Sends a recorded hike in for review. Needs the server; nothing is queued.
    func submit(_ a: Activity, name: String, review: SubmissionDoc.Review?) async throws -> String {
        let client = try ServerClient.current()
        let id = UUID().uuidString.lowercased()
        var hike = a
        hike.name = name
        let doc = SubmissionDoc(submitted_at: ms(Date()), name: name, review: review, public_use_consent: true,
                                app_version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
                                hike: ActivityDoc(hike))
        try await client.put(SyncCollection.submissions, id, doc)
        return id
    }

    func submissionStatus(_ id: String) async -> String? {
        guard let client = try? ServerClient.current(),
              let doc = try? await client.get(SyncCollection.submissions, id, as: SubmissionDoc.self), !doc.deleted,
              let s = doc.data else { return nil }
        return s.status
    }

    /// GET /health with the address as typed in Settings.
    static func checkConnection(_ base: URL) async -> String {
        do {
            try await ServerClient(baseURL: base, apiKey: "").health()
            return "Connected: the server is up."
        } catch {
            return error.localizedDescription
        }
    }
}

struct SyncSkipped: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
