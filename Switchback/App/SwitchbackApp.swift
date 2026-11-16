import SwiftUI

@main
struct SwitchbackApp: App {
    @StateObject private var app = AppState.shared
    @StateObject private var library = Library.shared
    @StateObject private var recorder = Recorder.shared
    @StateObject private var offline = OfflineStore.shared
    @StateObject private var profiles = Profiles.shared
    @StateObject private var explore = ExploreModel()
    @StateObject private var highlights = Highlights.shared
    @StateObject private var trailPhotos = TrailPhotos.shared
    @StateObject private var sync = SyncEngine.shared
    @AppStorage(Units.storageKey) private var units: Units = .systemDefault
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .id(units)   // redraw every number when the units change
                .environmentObject(app)
                .environmentObject(library)
                .environmentObject(recorder)
                .environmentObject(offline)
                .environmentObject(profiles)
                .environmentObject(explore)
                .environmentObject(highlights)
                .environmentObject(trailPhotos)
                .environmentObject(sync)
                .onOpenURL { url in app.importGPX(from: url) }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { recorder.flush() }
            // bring in other devices' changes on every return to the app (and send anything queued offline)
            if phase == .active { sync.syncSoon(after: 0) }
        }
    }
}

/// Hike is the map and the recorder in one: explore trails, then start recording from the same tab.
enum AppTab: Hashable { case hike, saved, activity }

struct AppMessage: Identifiable {
    let id = UUID()
    let title: String
    let text: String
}

@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()

    @Published var tab: AppTab = .hike
    /// The Hike tab shows the recorder instead of the trail map (always while a hike is being recorded).
    @Published var showRecorder = false
    @Published var message: AppMessage?

    func importGPX(from url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url)
            let trail = try GPX.trail(from: data, fallbackName: url.deletingPathExtension().lastPathComponent)
            Library.shared.save(trail)
            tab = .saved
            message = AppMessage(title: "Imported", text: "\(trail.name) (\(Fmt.distance(trail.length))) is in Saved.")
            if trail.profile == nil {
                Task { await Profiles.shared.ensureProfile(for: trail) }
            }
        } catch {
            message = AppMessage(title: "Couldn't import the GPX file", text: error.localizedDescription)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var recorder: Recorder

    var body: some View {
        Group {
            if #available(iOS 18.0, *) {
                TabView(selection: $app.tab) {
                    Tab("Hike", systemImage: "figure.hiking", value: AppTab.hike) { HikeView() }
                    Tab("Saved", systemImage: "bookmark.fill", value: AppTab.saved) { SavedView() }
                    Tab("Activity", systemImage: "chart.bar.xaxis", value: AppTab.activity) { ActivityListView() }
                }
            } else {
                TabView(selection: $app.tab) {
                    HikeView()
                        .tabItem { tabLabel("Hike", "figure.hiking") }
                        .tag(AppTab.hike)
                    SavedView()
                        .tabItem { tabLabel("Saved", "bookmark.fill") }
                        .tag(AppTab.saved)
                    ActivityListView()
                        .tabItem { tabLabel("Activity", "chart.bar.xaxis") }
                        .tag(AppTab.activity)
                }
            }
        }
        .tint(.trailGreen)
        .alert(item: $app.message) { m in
            Alert(title: Text(m.title), message: Text(m.text))
        }
    }

    /// The image and the text as two separate views, the form tab items always draw both of.
    @ViewBuilder
    private func tabLabel(_ title: String, _ symbol: String) -> some View {
        Image(systemName: symbol)
        Text(title)
    }
}

/// The Hike tab: the trail map with a button to start recording, or the recorder while a hike is going.
struct HikeView: View {
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var recorder: Recorder

    var body: some View {
        if app.showRecorder || recorder.state != .idle {
            RecordView()
        } else {
            ExploreView()
        }
    }
}
