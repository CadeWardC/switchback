import Foundation

/// Saved trails and recorded hikes, kept as JSON in Application Support.
@MainActor
final class Library: ObservableObject {
    static let shared = Library()

    @Published private(set) var trails: [Trail] = []
    @Published private(set) var activities: [Activity] = []

    private let trailsURL = Files.support.appendingPathComponent("saved-trails.json")
    private let activitiesURL = Files.support.appendingPathComponent("activities.json")

    init() {
        trails = Files.load([Trail].self, from: trailsURL) ?? []
        activities = Files.load([Activity].self, from: activitiesURL) ?? []
    }

    // MARK: Trails

    func isSaved(_ id: String) -> Bool { trails.contains { $0.id == id } }

    func toggleSaved(_ trail: Trail) {
        if isSaved(trail.id) { removeTrail(id: trail.id) } else { save(trail) }
    }

    func save(_ trail: Trail) {
        let t = Profiles.shared.withProfile(trail)
        if let i = trails.firstIndex(where: { $0.id == t.id }) {
            trails[i] = t
        } else {
            trails.insert(t, at: 0)
        }
        persistTrails()
    }

    func removeTrail(id: String) {
        trails.removeAll { $0.id == id }
        persistTrails()
    }

    func removeTrails(at offsets: IndexSet) {
        trails.remove(atOffsets: offsets)
        persistTrails()
    }

    func updateProfile(_ p: ElevationProfile, for id: String) {
        guard let i = trails.firstIndex(where: { $0.id == id }), trails[i].profile == nil else { return }
        trails[i].profile = p
        persistTrails()
    }

    func renameTrail(id: String, to name: String) {
        guard let i = trails.firstIndex(where: { $0.id == id }), !name.isEmpty else { return }
        trails[i].name = name
        persistTrails()
    }

    // MARK: Activities

    func add(_ a: Activity) {
        activities.insert(a, at: 0)
        persistActivities()
    }

    func deleteActivity(id: UUID) {
        activities.removeAll { $0.id == id }
        persistActivities()
    }

    func deleteActivities(at offsets: IndexSet) {
        activities.remove(atOffsets: offsets)
        persistActivities()
    }

    func renameActivity(id: UUID, to name: String) {
        guard let i = activities.firstIndex(where: { $0.id == id }), !name.isEmpty else { return }
        activities[i].name = name
        persistActivities()
    }

    // MARK: Backup

    /// Everything you'd lose by deleting the app: recorded hikes and saved trails, in one file.
    struct Backup: Codable {
        var app = "Switchback"
        var version = 1
        var exported = Date()
        var activities: [Activity]
        var trails: [Trail]
    }

    enum BackupError: LocalizedError {
        case notABackup

        var errorDescription: String? { "That isn't a Switchback backup file." }
    }

    /// Writes the backup to a temporary file, ready to share or save to Files.
    func backupFile() throws -> URL {
        let data = try JSONEncoder().encode(Backup(activities: activities, trails: trails))
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("backup", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let day = Date().formatted(.iso8601.year().month().day())
        let url = dir.appendingPathComponent("Switchback backup \(day).json")
        try data.write(to: url, options: .atomic)
        return url
    }

    /// Adds the hikes and saved trails from a backup file that aren't here already. Nothing is replaced or removed.
    func restore(from url: URL) throws -> (hikes: Int, trails: Int) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        guard let backup = try? JSONDecoder().decode(Backup.self, from: Compression.unpack(data)) else {
            throw BackupError.notABackup
        }
        let haveHikes = Set(activities.map(\.id))
        let newHikes = backup.activities.filter { !haveHikes.contains($0.id) }
        if !newHikes.isEmpty {
            activities = (activities + newHikes).sorted { $0.start > $1.start }
            persistActivities()
        }
        let haveTrails = Set(trails.map(\.id))
        let newTrails = backup.trails.filter { !haveTrails.contains($0.id) }
        if !newTrails.isEmpty {
            trails += newTrails
            persistTrails()
        }
        return (newHikes.count, newTrails.count)
    }

    private func persistTrails() { Files.save(trails, to: trailsURL) }
    private func persistActivities() { Files.save(activities, to: activitiesURL) }
}
