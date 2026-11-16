import Foundation

/// Saved trails and recorded hikes, kept as JSON in Application Support. This is the source of truth on the
/// phone: everything works without a server. When server sync is set up, every change here is also queued for
/// `SyncEngine`, and changes from other devices come back through the `applyRemote` methods.
@MainActor
final class Library: ObservableObject {
    static let shared = Library()

    @Published private(set) var trails: [Trail] = []
    @Published private(set) var activities: [Activity] = []

    private let trailsURL = Files.support.appendingPathComponent("saved-trails.json")
    private let activitiesURL = Files.support.appendingPathComponent("activities.json")
    private let savedAtURL = Files.support.appendingPathComponent("saved-trails-dates.json")
    /// When each trail was saved (newest first in the list); trails saved before this was kept count as older.
    private var savedAtById: [String: Date] = [:]

    init() {
        trails = Files.load([Trail].self, from: trailsURL) ?? []
        activities = Files.load([Activity].self, from: activitiesURL) ?? []
        savedAtById = Files.load([String: Date].self, from: savedAtURL) ?? [:]
    }

    private var sync: SyncEngine { SyncEngine.shared }

    // MARK: Trails

    func isSaved(_ id: String) -> Bool { trails.contains { $0.id == id } }

    /// Trails from before dates were kept get times a second apart in list order, so the order survives a sync.
    func savedAt(_ id: String) -> Date {
        if let d = savedAtById[id] { return d }
        let i = trails.firstIndex { $0.id == id } ?? 0
        return Date(timeIntervalSince1970: 1_700_000_000 - Double(i))
    }

    func toggleSaved(_ trail: Trail) {
        if isSaved(trail.id) { removeTrail(id: trail.id) } else { save(trail) }
    }

    func save(_ trail: Trail) {
        let t = Profiles.shared.withProfile(trail)
        if let i = trails.firstIndex(where: { $0.id == t.id }) {
            trails[i] = t
        } else {
            trails.insert(t, at: 0)
            savedAtById[t.id] = Date()
            persistDates()
        }
        persistTrails()
        sync.trailChanged(t.id)
    }

    func removeTrail(id: String) {
        guard isSaved(id) else { return }
        trails.removeAll { $0.id == id }
        persistTrails()
        sync.trailChanged(id, deleted: true)
    }

    func removeTrails(at offsets: IndexSet) {
        let ids = offsets.map { trails[$0].id }
        trails.remove(atOffsets: offsets)
        persistTrails()
        ids.forEach { sync.trailChanged($0, deleted: true) }
    }

    func updateProfile(_ p: ElevationProfile, for id: String) {
        guard let i = trails.firstIndex(where: { $0.id == id }), trails[i].profile == nil else { return }
        trails[i].profile = p
        persistTrails()
        sync.trailChanged(id)
    }

    func renameTrail(id: String, to name: String) {
        guard let i = trails.firstIndex(where: { $0.id == id }), !name.isEmpty else { return }
        trails[i].name = name
        persistTrails()
        sync.trailChanged(id)
    }

    // MARK: Activities

    func add(_ a: Activity) {
        activities.insert(a, at: 0)
        persistActivities()
        sync.activityChanged(a.id)
    }

    func deleteActivity(id: UUID) {
        activities.removeAll { $0.id == id }
        persistActivities()
        sync.activityChanged(id, deleted: true)
    }

    func deleteActivities(at offsets: IndexSet) {
        let ids = offsets.map { activities[$0].id }
        activities.remove(atOffsets: offsets)
        persistActivities()
        ids.forEach { sync.activityChanged($0, deleted: true) }
    }

    func renameActivity(id: UUID, to name: String) {
        guard let i = activities.firstIndex(where: { $0.id == id }), !name.isEmpty else { return }
        activities[i].name = name
        persistActivities()
        sync.activityChanged(id)
    }

    func markSubmitted(id: UUID, submissionId: String) {
        guard let i = activities.firstIndex(where: { $0.id == id }) else { return }
        activities[i].submissionId = submissionId
        persistActivities()
        sync.activityChanged(id)
    }

    // MARK: From the server (not queued again)

    func applyRemote(_ trail: Trail, savedAt: Date) {
        savedAtById[trail.id] = savedAt
        if let i = trails.firstIndex(where: { $0.id == trail.id }) {
            trails[i] = trail
        } else {
            let at = trails.firstIndex { self.savedAt($0.id) < savedAt } ?? trails.endIndex
            trails.insert(trail, at: at)
        }
        persistDates()
        persistTrails()
    }

    func applyRemoteTrailDeletion(docId: String) {
        let before = trails.count
        trails.removeAll { SyncIDs.trail($0.id) == docId }
        if trails.count != before { persistTrails() }
    }

    func applyRemote(_ a: Activity) {
        if let i = activities.firstIndex(where: { $0.id == a.id }) {
            activities[i] = a
        } else {
            let at = activities.firstIndex { $0.start < a.start } ?? activities.endIndex
            activities.insert(a, at: at)
        }
        persistActivities()
    }

    func applyRemoteActivityDeletion(docId: String) {
        let before = activities.count
        activities.removeAll { SyncIDs.activity($0.id) == docId }
        if activities.count != before { persistActivities() }
    }

    private func persistTrails() { Files.save(trails, to: trailsURL) }
    private func persistActivities() { Files.save(activities, to: activitiesURL) }
    private func persistDates() { Files.save(savedAtById, to: savedAtURL) }
}
