import MapKit
import SwiftUI

struct ExploreView: View {
    @EnvironmentObject private var model: ExploreModel
    @EnvironmentObject private var recorder: Recorder
    @EnvironmentObject private var profiles: Profiles
    @AppStorage(BaseMap.storageKey) private var baseMap: BaseMap = .switchback
    @AppStorage(BaseMap.showRoutesKey) private var showRoutes = false
    @State private var mode: Mode = .map
    @State private var query = ""
    @State private var showFilters = false
    @State private var showSettings = false
    @State private var didCenter = false

    enum Mode: String, CaseIterable { case map = "Map", list = "List" }

    var body: some View {
        NavigationStack {
            Group {
                if mode == .map { mapMode } else { listMode }
            }
            .navigationTitle("Explore")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search trails or places")
            .autocorrectionDisabled()
            .onChange(of: query) { _, text in model.nameFilter = text }
            .onSubmit(of: .search) {
                // no trail by that name here: look it up as a place instead, and go there
                guard model.filtered.isEmpty else { return }
                let place = query
                Task {
                    if await model.searchPlace(place) { query = "" }
                }
            }
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Picker("View", selection: $mode) {
                        ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 160)
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("Settings")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showFilters = true } label: {
                        Image(systemName: model.filters.isActive ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                    }
                    .accessibilityLabel("Filters")
                }
            }
            .navigationDestination(for: Trail.self) { TrailDetailView(trail: $0) }
            .navigationDestination(for: TrailSystem.self) { TrailSystemView(system: $0) }
            .sheet(isPresented: $showFilters) {
                FiltersView(filters: $model.filters, sort: $model.sort)
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .onAppear {
                recorder.locateOnce()
                if !didCenter, let loc = recorder.lastLocation {
                    didCenter = true
                    if model.shouldCenter(on: loc) { model.center(on: loc) }
                }
            }
            .onReceive(recorder.$lastLocation) { loc in
                guard !didCenter, let loc else { return }
                didCenter = true
                if model.shouldCenter(on: loc) { model.center(on: loc) }
            }
        }
    }

    // MARK: Map

    private var mapMode: some View {
        // the trail you tapped is drawn as the hike you'd walk: with the way in from its trailhead (the nearest to you)
        let here = recorder.lastLocation.map { Coord($0.coordinate) }
        let trails = model.filtered.map { t -> Trail in
            guard t.id == model.selectedId, let from = t.defaultAccess(near: here) else { return t }
            return t.hike(from: from, adding: [])
        }
        return ZStack {
            AppMap(baseMap: baseMap, trails: trails, selectedId: model.selectedId, camera: model.cameraRequest,
                   initialBox: model.initialBox,
                   showsRoutes: showRoutes,
                   onSelect: { id in withAnimation(.snappy) { model.selectedId = id } },
                   onRegionChange: { model.regionChanged($0) },
                   onVisibleTrails: { model.tilePreviews($0) })

            VStack(spacing: 8) {
                statusBar
                Spacer()
                if let t = model.selectedTrail {
                    NavigationLink(value: t) {
                        HStack {
                            TrailRow(trail: t, distanceAway: model.distanceFromUser(t))
                            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                        }
                        .padding(12)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 12)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                } else if !trails.isEmpty {
                    Button { mode = .list } label: {
                        Label("\(model.listed.count) hikes · List", systemImage: "list.bullet")
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(.regularMaterial, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 0) {
                        if showRoutes { MapAttribution(baseMap: .waymarkedHiking) }
                        MapAttribution(baseMap: baseMap)
                    }
                    Spacer()
                    mapStyleMenu
                }
            }
            .padding(.bottom, 4)
        }
    }

    @ViewBuilder
    private var statusBar: some View {
        VStack(spacing: 6) {
            if model.isLoading {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Finding trails…")
                }
                .font(.subheadline.weight(.semibold))
                .capsuleStyle()
            } else if model.isTooWide {
                Label("Zoom in to see trails", systemImage: "plus.magnifyingglass")
                    .font(.subheadline.weight(.semibold))
                    .capsuleStyle()
            }
            if let e = model.errorText {
                Button { model.reload() } label: {
                    Label(e, systemImage: "arrow.clockwise")
                        .font(.caption)
                        .multilineTextAlignment(.center)
                        .capsuleStyle()
                }
                .buttonStyle(.plain)
            } else if model.usedOffline {
                Label("No signal: showing downloaded trails", systemImage: "wifi.slash")
                    .font(.caption)
                    .capsuleStyle()
            } else if model.loadedOnce && model.results.isEmpty && !model.isLoading && !model.isTooWide {
                Text("No mapped trails here")
                    .font(.caption)
                    .capsuleStyle()
            }
        }
        .padding(.top, 8)
        .padding(.horizontal, 60)
        .animation(.easeInOut(duration: 0.2), value: model.isLoading)
    }

    private var mapStyleMenu: some View {
        Menu {
            Picker("Map style", selection: $baseMap) {
                ForEach(BaseMap.baseStyles) { Text($0.title).tag($0) }
            }
            Toggle(isOn: $showRoutes) {
                Label("Hiking routes layer", systemImage: "signpost.right.and.left")
            }
        } label: {
            Image(systemName: "square.3.layers.3d")
                .font(.title3)
                .padding(10)
                .background(.regularMaterial, in: Circle())
        }
        .padding(10)
    }

    // MARK: List

    private var listMode: some View {
        let trails = model.listed
        let groups = model.grouped(trails)
        return List {
            Section {
                EmptyView()
            } header: {
                HStack {
                    Text(model.isLoading ? "Searching…" : "\(trails.count) hikes")
                    Spacer()
                    Menu {
                        Picker("Sort", selection: $model.sort) {
                            ForEach(TrailSort.allCases) { Text($0.title).tag($0) }
                        }
                    } label: {
                        Label(model.sort.title, systemImage: "arrow.up.arrow.down")
                            .font(.caption.weight(.semibold))
                    }
                }
            }
            ForEach(groups, id: \.area) { group in
                Section {
                    ForEach(listRows(group.trails)) { row in
                        if let name = row.system {
                            // a trail system's header (tap for its map and side trails); its trails follow right below
                            NavigationLink(value: TrailSystem(name: name, trails: model.systemMembers(name))) {
                                TrailSystemRow(name: name, trails: row.trails)
                            }
                        } else if let t = row.trails.first {
                            NavigationLink(value: t) {
                                TrailRow(trail: t, distanceAway: model.distanceFromUser(t))
                            }
                        }
                    }
                } header: {
                    if !group.area.isEmpty {
                        HStack(spacing: 6) {
                            Image(systemName: group.area == "Other trails" ? "point.topleft.down.to.point.bottomright.curvepath" : "tree.fill")
                                .foregroundStyle(Color.trailGreen)
                            Text(group.area)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.primary)
                                .textCase(nil)
                            Spacer()
                            Text("\(group.trails.count)")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if trails.isEmpty && !model.isLoading && model.nameFilter.isEmpty {
                ContentUnavailableView {
                    Label("No trails", systemImage: "figure.hiking")
                } description: {
                    Text(model.results.isEmpty
                         ? "Move the map to where you want to hike; trails load as you go."
                         : "No trails match your filters.")
                } actions: {
                    if model.results.isEmpty {
                        Button("Show map") { mode = .map }
                    } else {
                        Button("Clear filters") { model.filters = TrailFilters() }
                    }
                }
            }
        }
    }
}

/// A row of the trail list: one trail, or a trail system standing for its trails.
private struct ListRow: Identifiable {
    let id: String
    let system: String?
    let trails: [Trail]
}

private func listRows(_ trails: [Trail]) -> [ListRow] {
    var members: [String: [Trail]] = [:]
    for t in trails { if let s = t.system { members[s, default: []].append(t) } }
    var rows: [ListRow] = []
    var placed = Set<String>()
    for t in trails {
        if let s = t.system, let all = members[s], all.count > 1 {
            // the system's header, then its trails together, where its nearest trail falls in the list
            guard placed.insert(s).inserted else { continue }
            rows.append(ListRow(id: "system:" + s, system: s, trails: all))
            rows += all.map { ListRow(id: $0.id, system: nil, trails: [$0]) }
        } else {
            rows.append(ListRow(id: t.id, system: nil, trails: [t]))
        }
    }
    return rows
}

private extension View {
    func capsuleStyle() -> some View {
        padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(.regularMaterial, in: Capsule())
    }
}

struct FiltersView: View {
    @Binding var filters: TrailFilters
    @Binding var sort: TrailSort
    @Environment(\.dismiss) private var dismiss

    private var lengthOptions: [Double?] {
        let imperial: [Double] = [1, 3, 5, 8, 12, 20]
        let metric: [Double] = [2, 5, 8, 12, 20, 30]
        let meters: [Double] = Units.current == .imperial
            ? imperial.map { $0 * Fmt.metersPerMile }
            : metric.map { $0 * 1000 }
        let options: [Double?] = meters.map { Optional($0) }
        return [nil] + options
    }

    private var gainOptions: [Double?] {
        let imperial: [Double] = [500, 1000, 2000, 3000, 5000]
        let metric: [Double] = [150, 300, 600, 1000, 1500]
        let meters: [Double] = Units.current == .imperial
            ? imperial.map { $0 / Fmt.feetPerMeter }
            : metric
        let options: [Double?] = meters.map { Optional($0) }
        return [nil] + options
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Sort by") {
                    Picker("Sort by", selection: $sort) {
                        ForEach(TrailSort.allCases) { Text($0.title).tag($0) }
                    }
                }
                Section("Difficulty") {
                    ForEach(Difficulty.allCases) { d in
                        Toggle(isOn: Binding(
                            get: { !filters.excluded.contains(d) },
                            set: { on in
                                if on { filters.excluded.remove(d) } else { filters.excluded.insert(d) }
                            }
                        )) {
                            DifficultyBadge(difficulty: d)
                        }
                    }
                }
                Section {
                    Picker("Max length", selection: $filters.maxLength) {
                        ForEach(lengthOptions, id: \.self) { v in
                            Text(v.map { Fmt.distance($0) } ?? "Any").tag(v)
                        }
                    }
                    Picker("Max elevation gain", selection: $filters.maxGain) {
                        ForEach(gainOptions, id: \.self) { v in
                            Text(v.map { Fmt.elevation($0) } ?? "Any").tag(v)
                        }
                    }
                    Toggle("Loops only", isOn: $filters.loopsOnly)
                } footer: {
                    Text("Difficulty is worked out from each trail's length and climb (and its SAC scale when mapped).")
                }
                Section {
                    Button("Reset filters", role: .destructive) { filters = TrailFilters() }
                        .disabled(!filters.isActive)
                }
            }
            .navigationTitle("Filters")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
