import MapKit
import SwiftUI

struct TrailDetailView: View {
    @State private var trail: Trail
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var recorder: Recorder
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var profiles: Profiles
    @EnvironmentObject private var highlights: Highlights
    @EnvironmentObject private var trailPhotos: TrailPhotos
    @EnvironmentObject private var offline: OfflineStore
    @AppStorage(BaseMap.storageKey) private var baseMap: BaseMap = .switchback
    @AppStorage(BaseMap.showRoutesKey) private var showRoutes = false
    @State private var gpxURL: URL?
    @State private var renaming = false
    @State private var newName = ""
    /// The trailhead to start from: nil = the nearest one, "" = the trail on its own.
    @State private var startId: String?
    @State private var addedIds: Set<String> = []

    init(trail: Trail) {
        _trail = State(initialValue: trail)
    }

    private var shown: Trail {
        let saved = library.trails.first { $0.id == trail.id }
        return profiles.withProfile(saved ?? trail)
    }

    /// The trailhead the hike starts from: the one picked, else the one nearest you (or nearest the trail).
    private func start(_ base: Trail) -> TrailAccess? {
        let points = base.accessPoints
        if let startId { return points.first { $0.id == startId } }
        return base.defaultAccess(near: recorder.lastLocation.map { Coord($0.coordinate) })
    }

    var body: some View {
        let base = shown
        let from = start(base)
        let t = base.hike(from: from, adding: base.extensions.filter { addedIds.contains($0.id) })
        let pois = highlights.pois(for: t.id) ?? []
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                TrailHero(trail: t, photos: trailPhotos.photos(for: t.id) ?? [])

                ZStack(alignment: .bottomLeading) {
                    AppMap(baseMap: baseMap, trails: [t], selectedId: t.id, initialBox: t.bbox, showsUserButton: false,
                                 showsRoutes: showRoutes, pois: pois)
                    MapAttribution(baseMap: baseMap)
                }
                .frame(height: 300)
                .clipShape(RoundedRectangle(cornerRadius: 18))

                VStack(alignment: .leading, spacing: 6) {
                    Text(t.name)
                        .font(.title2.bold())
                    if let area = t.area {
                        Label(area, systemImage: "tree.fill")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Color.trailGreen)
                    }
                    HStack(spacing: 8) {
                        DifficultyBadge(difficulty: t.difficulty)
                        Text(t.routeTypeTitle)
                        if let away = distanceAway(t) {
                            Text("· \(Fmt.distance(away)) away")
                        }
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    if let summary = highlightSummary(pois) {
                        Label(summary, systemImage: "sparkles")
                            .font(.subheadline)
                            .foregroundStyle(Color.trailGreen)
                    }
                }

                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .leading), count: 3), alignment: .leading, spacing: 14) {
                    StatTile(title: "Length", value: Fmt.distance(t.length))
                    StatTile(title: "Elevation gain", value: t.profile.map { Fmt.elevation($0.gain) } ?? "…")
                    StatTile(title: "Est. time", value: Fmt.duration(t.estimatedDuration))
                    StatTile(title: "Highest point", value: t.profile.map { Fmt.elevation($0.maxElevation) } ?? "…")
                    StatTile(title: "Descent", value: t.profile.map { Fmt.elevation($0.loss) } ?? "…")
                    if !t.isLoop {
                        StatTile(title: "Out & back", value: Fmt.distance(t.length * 2))
                    }
                }

                hikeOptions(base, from: from, chartIsTrailOnly: t.tags["switchback:chart"] == "trail")

                actions(t)
                offlineButton(t)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Elevation").font(.headline)
                    if let p = t.profile {
                        ElevationChart(profile: p)
                    } else if profiles.isLoading(t) {
                        HStack { ProgressView(); Text("Loading elevation…").foregroundStyle(.secondary) }
                            .frame(maxWidth: .infinity, minHeight: 120)
                    } else {
                        Button("Load elevation") { Task { await profiles.ensureProfile(for: t) } }
                            .frame(maxWidth: .infinity, minHeight: 120)
                    }
                }

                if !pois.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Along the trail").font(.headline)
                        HighlightsList(pois: pois)
                    }
                } else if highlights.isLoading(t.id) {
                    HStack { ProgressView(); Text("Finding viewpoints, water and more…").foregroundStyle(.secondary) }
                        .font(.subheadline)
                }

                if t.summary != nil || !t.facts.isEmpty || t.website != nil {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("About").font(.headline)
                        if let s = t.summary {
                            Text(s).font(.body)
                        }
                        ForEach(t.facts, id: \.title) { f in
                            LabeledContent(f.title, value: f.value)
                                .font(.subheadline)
                        }
                        if let url = t.website {
                            Link("Website", destination: url)
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 6) {
                    if let url = t.osmURL {
                        Link("View or fix on OpenStreetMap", destination: url)
                            .font(.subheadline)
                    }
                    Text(credit(t))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding()
        }
        .navigationTitle(t.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    library.toggleSaved(base)
                } label: {
                    Image(systemName: library.isSaved(t.id) ? "bookmark.fill" : "bookmark")
                }
                .accessibilityLabel(library.isSaved(t.id) ? "Unsave" : "Save")
            }
            if library.isSaved(t.id) {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Rename") {
                            newName = t.name
                            renaming = true
                        }
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
        }
        .alert("Rename trail", isPresented: $renaming) {
            TextField("Name", text: $newName)
            Button("Save") { library.renameTrail(id: t.id, to: newName) }
            Button("Cancel", role: .cancel) {}
        }
        .task(id: t.id) {
            gpxURL = try? GPX.file(named: t.name, contents: GPX.document(for: shown))
            async let profile = profiles.ensureProfile(for: base)
            let found = await highlights.ensure(for: base)
            await trailPhotos.ensure(for: base, pois: found)
            _ = await profile
        }
    }

    /// Where to start from (trailheads and car parks, with the walk in) and side loops to add.
    @ViewBuilder
    private func hikeOptions(_ base: Trail, from: TrailAccess?, chartIsTrailOnly: Bool) -> some View {
        let points = base.accessPoints
        let extras = base.extensions
        if !points.isEmpty || !extras.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                if !points.isEmpty {
                    Menu {
                        Picker("Start from", selection: Binding(get: { from?.id ?? "" }, set: { startId = $0 })) {
                            ForEach(points) { p in
                                Text("\(p.name) · \(Fmt.distance(base.hike(from: p, adding: []).length))").tag(p.id)
                            }
                            Text("The trail on its own · \(Fmt.distance(base.length))").tag("")
                        }
                    } label: {
                        HStack {
                            Image(systemName: "parkingsign.circle.fill").foregroundStyle(Color.trailGreen)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Start from").font(.caption).foregroundStyle(.secondary)
                                Text(from?.name ?? "The trail on its own").font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.primary)
                            }
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if let from, from.distance >= 30 {
                        Text(base.isLoop
                             ? "\(Fmt.distance(base.length)) loop + \(Fmt.distance(from.distance)) each way from the trailhead.\(chartIsTrailOnly ? " Elevation is for the trail itself." : "")"
                             : "\(Fmt.distance(base.length)) trail + \(Fmt.distance(from.distance)) from the trailhead.\(chartIsTrailOnly ? " Elevation is for the trail itself." : "")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                ForEach(extras) { e in
                    Toggle(isOn: Binding(get: { addedIds.contains(e.id) },
                                         set: { on in if on { addedIds.insert(e.id) } else { addedIds.remove(e.id) } })) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Add \(e.name)").font(.subheadline.weight(.semibold))
                            Text("+ \(Fmt.distance(e.length))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .tint(Color.trailGreen)
                }
            }
            .padding(12)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        }
    }

    @ViewBuilder
    private func actions(_ t: Trail) -> some View {
        HStack(spacing: 10) {
            Button {
                recorder.follow(t)
                app.tab = .record
            } label: {
                Label(recorder.following?.id == t.id ? "Following" : "Navigate", systemImage: "location.north.line.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)

            Button {
                openDirections(to: t)
            } label: {
                Label("Drive", systemImage: "car.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)

            if let gpxURL {
                ShareLink(item: gpxURL) {
                    Label("GPX", systemImage: "square.and.arrow.up")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        }
        .controlSize(.large)
    }

    @ViewBuilder
    private func offlineButton(_ t: Trail) -> some View {
        let area = offline.area(covering: t.bbox)
        let progress = area.flatMap { offline.progress[$0.id] }
        Button {
            if let area, !area.complete, progress == nil {
                offline.retry(area)
            } else if area == nil {
                library.save(t)
                offline.download(trail: t, source: baseMap.offlineSource)
            }
        } label: {
            Group {
                if let progress {
                    Label("Downloading map… \(Int(progress * 100))%", systemImage: "arrow.down.circle")
                } else if let area, area.complete {
                    Label("Available offline (\(area.baseMap.shortTitle))", systemImage: "checkmark.circle.fill")
                } else if area != nil {
                    Label("Offline map incomplete · Retry", systemImage: "arrow.clockwise")
                } else {
                    Label("Download for offline", systemImage: "arrow.down.circle")
                }
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .disabled(progress != nil || area?.complete == true)
    }

    private func distanceAway(_ t: Trail) -> Double? {
        recorder.lastLocation.map { Geo.distance(Coord($0.coordinate), t.start) }
    }

    private func credit(_ t: Trail) -> String {
        switch t.source {
        case .osmRelation, .osmWay:
            return (t.tags["usfs:trail_class"] != nil ? "Includes U.S. Forest Service details. " : "") + "Trail data © OpenStreetMap contributors (ODbL). Elevation from Open-Meteo / Copernicus DEM. Difficulty and time are estimates; check conditions before you go."
        case .usfs:
            return "Trail data from the U.S. Forest Service (public domain). Elevation from Open-Meteo / Copernicus DEM. Difficulty and time are estimates; check conditions with the ranger district before you go."
        case .imported:
            return "Imported from a GPX file."
        case .recorded:
            return "Recorded with Switchback."
        }
    }

    private func openDirections(to t: Trail) {
        let item = MKMapItem(placemark: MKPlacemark(coordinate: t.start.cl))
        item.name = "\(t.name) trailhead"
        item.openInMaps(launchOptions: [MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving])
    }
}
