import Foundation
import SwiftUI

extension Color {
    static let trailGreen = Color(red: 0.13, green: 0.42, blue: 0.27)
}

enum Difficulty: String, Codable, CaseIterable, Identifiable, Comparable {
    case easy, moderate, hard, veryHard

    var id: String { rawValue }

    var title: String {
        switch self {
        case .easy: return "Easy"
        case .moderate: return "Moderate"
        case .hard: return "Hard"
        case .veryHard: return "Very hard"
        }
    }

    var color: Color {
        switch self {
        case .easy: return .green
        case .moderate: return .blue
        case .hard: return .red
        case .veryHard: return .purple
        }
    }

    private var rank: Int { Difficulty.allCases.firstIndex(of: self) ?? 0 }

    static func < (a: Difficulty, b: Difficulty) -> Bool { a.rank < b.rank }
}

/// Elevation along a line: distances from the start (m) and heights (m).
struct ElevationProfile: Codable, Hashable {
    var distances: [Double]
    var elevations: [Double]
    var gain: Double
    var loss: Double
    var minElevation: Double
    var maxElevation: Double

    /// `threshold` ignores wiggles smaller than that many metres when adding up the climb.
    init(distances: [Double], elevations: [Double], threshold: Double = 2) {
        self.distances = distances
        self.elevations = elevations
        var gain = 0.0, loss = 0.0
        if var ref = elevations.first {
            for e in elevations.dropFirst() {
                if e - ref >= threshold {
                    gain += e - ref
                    ref = e
                } else if ref - e >= threshold {
                    loss += ref - e
                    ref = e
                }
            }
        }
        self.gain = gain
        self.loss = loss
        minElevation = elevations.min() ?? 0
        maxElevation = elevations.max() ?? 0
    }
}

extension ElevationProfile {
    /// A profile as trail packs store it: {s: metres per step, p: (steps, metres) deltas, g, l, mn, mx}.
    init?(packed: [String: Any]) {
        guard let s = (packed["s"] as? NSNumber)?.doubleValue, let p = packed["p"] as? String else { return nil }
        let ints = Polyline.decodeInts(p)
        guard ints.count >= 4 else { return nil }
        var distances: [Double] = [], elevations: [Double] = []
        var step = 0, height = 0, i = 0
        while i + 1 < ints.count {
            step += ints[i]
            height += ints[i + 1]
            distances.append(Double(step) * s)
            elevations.append(Double(height))
            i += 2
        }
        self.init(distances: distances, elevations: elevations)
        if let g = (packed["g"] as? NSNumber)?.doubleValue { gain = g }
        if let l = (packed["l"] as? NSNumber)?.doubleValue { loss = l }
        if let mn = (packed["mn"] as? NSNumber)?.doubleValue { minElevation = mn }
        if let mx = (packed["mx"] as? NSNumber)?.doubleValue { maxElevation = mx }
    }

    var total: Double { distances.last ?? 0 }

    /// The height at a distance along the profile.
    func height(at d: Double) -> Double {
        guard let first = elevations.first, let last = elevations.last else { return 0 }
        if d <= (distances.first ?? 0) { return first }
        if d >= total { return last }
        let i = distances.firstIndex { $0 >= d } ?? (distances.count - 1)
        guard i > 0, distances[i] > distances[i - 1] else { return elevations[i] }
        let t = (d - distances[i - 1]) / (distances[i] - distances[i - 1])
        return elevations[i - 1] + (elevations[i] - elevations[i - 1]) * t
    }

    /// The chart points between two distances, measured from the first.
    private func points(from a: Double, to b: Double) -> [(Double, Double)] {
        guard b > a else { return [] }
        var out: [(Double, Double)] = [(0, height(at: a))]
        for (d, e) in zip(distances, elevations) where d > a && d < b { out.append((d - a, e)) }
        out.append((b - a, height(at: b)))
        return out
    }

    /// Profiles walked one after another. The climb and descent are the parts' own (they come from finer samples
    /// than the chart points).
    private static func joined(_ parts: [[(Double, Double)]], gain: Double, loss: Double, low: Double, high: Double) -> ElevationProfile {
        var distances: [Double] = [], elevations: [Double] = []
        var offset = 0.0
        for part in parts where !part.isEmpty {
            for (d, e) in part {
                distances.append(offset + d)
                elevations.append(e)
            }
            offset += part.last?.0 ?? 0
        }
        var p = ElevationProfile(distances: distances, elevations: elevations)
        p.gain = gain
        p.loss = loss
        p.minElevation = low
        p.maxElevation = high
        return p
    }

    private var all: [(Double, Double)] { points(from: 0, to: total) }

    /// The same line walked the other way.
    var backwards: ElevationProfile {
        let pts = all.reversed().map { (total - $0.0, $0.1) }
        return Self.joined([pts], gain: loss, loss: gain, low: minElevation, high: maxElevation)
    }

    /// A loop's profile starting from another point on it.
    func rotated(to d: Double) -> ElevationProfile {
        guard d > 0, d < total else { return self }
        return Self.joined([points(from: d, to: total), points(from: 0, to: d)], gain: gain, loss: loss,
                           low: minElevation, high: maxElevation)
    }

    /// This profile with another walked in the middle of it (a side loop from a junction).
    func inserting(_ other: ElevationProfile, at d: Double) -> ElevationProfile {
        Self.joined([points(from: 0, to: d), other.all, points(from: d, to: total)], gain: gain + other.gain,
                    loss: loss + other.loss, low: min(minElevation, other.minElevation),
                    high: max(maxElevation, other.maxElevation))
    }

    /// This profile without the stretch between two distances (an out-and-back that isn't walked).
    func removing(from a: Double, to b: Double) -> ElevationProfile {
        let a = max(0, a), b = min(total, b)
        guard b > a else { return self }
        let cut = points(from: a, to: b)
        let gone = ElevationProfile(distances: cut.map { $0.0 }, elevations: cut.map { $0.1 })
        var p = Self.joined([points(from: 0, to: a), points(from: b, to: total)], gain: max(0, gain - gone.gain),
                            loss: max(0, loss - gone.loss), low: minElevation, high: maxElevation)
        p.minElevation = p.elevations.min() ?? minElevation
        p.maxElevation = p.elevations.max() ?? maxElevation
        return p
    }

    /// This profile, then another.
    func then(_ other: ElevationProfile) -> ElevationProfile {
        Self.joined([all, other.all], gain: gain + other.gain, loss: loss + other.loss,
                    low: min(minElevation, other.minElevation), high: max(maxElevation, other.maxElevation))
    }
}

struct TrailFact: Hashable {
    let title: String
    let value: String
}

struct Trail: Codable, Identifiable, Hashable {
    enum Source: String, Codable {
        case osmRelation, osmWay, imported, recorded, usfs
    }

    var id: String
    var name: String
    var source: Source
    var osmId: Int64?
    /// Every line of the trail, as drawn on the map.
    var segments: [[Coord]]
    /// The main continuous line: used for the length, the elevation profile and navigation.
    var path: [Coord]
    var length: Double
    var tags: [String: String]
    var profile: ElevationProfile?

    static func == (a: Trail, b: Trail) -> Bool {
        a.id == b.id && a.name == b.name && a.profile == b.profile
    }

    func hash(into hasher: inout Hasher) { hasher.combine(id) }

    var start: Coord { path.first ?? segments.first?.first ?? Coord(lat: 0, lon: 0) }

    var bbox: BBox {
        BBox(coords: segments.flatMap { $0 }) ?? BBox(south: start.lat, west: start.lon, north: start.lat, east: start.lon)
    }

    var isLoop: Bool {
        guard let f = path.first, let l = path.last, length > 500 else { return false }
        return Geo.distance(f, l) < max(150, length * 0.03)
    }

    /// A route drawn over a whole web of trails (several loops), not one walk: its length is all of its trails.
    var isNetwork: Bool { tags["switchback:network"] == "yes" }

    var routeTypeTitle: String { isNetwork ? "Trail network" : isLoop ? "Loop" : "One way" }

    /// A path mapped in OpenStreetMap without a name.
    var isUnnamed: Bool { tags["switchback:unnamed"] == "yes" }

    /// Not a hiking trail as far as we can tell: official lists say it isn't for hikers (ORV, snowmobile, water…), or
    /// it's on no official list and nothing in the map says people hike it. Hidden unless "Informal trails" is on.
    var isInformal: Bool { tags["switchback:informal"] == "yes" }

    /// An access trail, spur or connector: not a hike of its own. Hidden unless "Side trails" is on (it still
    /// appears in its trail system, and as the walk in to the hikes it leads to).
    var isSide: Bool { tags["switchback:side"] == "yes" }

    /// A hike to list: a loop, a trail with a trailhead, a trail an official list has, or part of a trail system.
    /// Side trails, road walks, short fragments and unnamed lines aren't; they stay on the map. Trail files decide
    /// (switchback:hike=no); a trail from anywhere else counts unless it's plainly a side trail.
    var isHike: Bool {
        tags["switchback:hike"] != "no" && !isSide && !isInformal && !isUnnamed
    }

    /// "List every trail" in Settings: the list shows side trails, road walks, fragments and unnamed paths too.
    static let sideKey = "sideTrails"
    static var showsSide: Bool { UserDefaults.standard.bool(forKey: sideKey) }

    /// The trail system this belongs to ("Cedar Creek Trail").
    var system: String? { tags["switchback:system"] }

    /// Trailheads and car parks this trail can be started from, nearest first, with the walk in.
    var accessPoints: [TrailAccess] {
        guard let rows = Self.json(tags["switchback:access"]) else { return [] }
        return rows.compactMap { r in
            guard let name = r["n"] as? String, let d = (r["d"] as? NSNumber)?.doubleValue,
                  let p = r["p"] as? [NSNumber], p.count == 2 else { return nil }
            let point = Coord(lat: p[0].doubleValue, lon: p[1].doubleValue)
            return TrailAccess(name: name, distance: d, point: point, line: (r["l"] as? String).map(Polyline.decode) ?? [],
                               profile: (r["e"] as? [String: Any]).flatMap { ElevationProfile(packed: $0) },
                               via: (r["v"] as? [String]) ?? [])
        }
    }

    /// Loops that hang off this loop and can be added to the hike.
    var extensions: [TrailExtension] {
        guard let rows = Self.json(tags["switchback:ext"]) else { return [] }
        return rows.compactMap { r in
            guard let id = r["id"] as? String, let name = r["n"] as? String, let m = (r["m"] as? NSNumber)?.doubleValue,
                  let line = r["l"] as? String else { return nil }
            return TrailExtension(id: id, name: name, length: m, line: Polyline.decode(line),
                                  profile: (r["e"] as? [String: Any]).flatMap { ElevationProfile(packed: $0) })
        }
    }

    /// Shorter loops of this trail, by a cut-across that isn't a trail of its own ("Short loop").
    var shortLoops: [TrailExtension] {
        guard let rows = Self.json(tags["switchback:short"]) else { return [] }
        return rows.compactMap { r in
            guard let name = r["n"] as? String, let m = (r["m"] as? NSNumber)?.doubleValue,
                  let line = r["l"] as? String else { return nil }
            return TrailExtension(id: "short-\(Int(m))", name: name, length: m, line: Polyline.decode(line),
                                  profile: (r["e"] as? [String: Any]).flatMap { ElevationProfile(packed: $0) })
        }
    }

    /// This trail walked as one of its short loops: the same trail and trailheads, a shorter line.
    func shortened(to short: TrailExtension) -> Trail {
        guard short.line.count > 1 else { return self }
        var t = self
        t.path = short.line
        t.length = short.length
        t.profile = short.profile
        t.segments.append(short.line)      // so the cut-across is drawn
        // these were worked out for the whole loop
        for tag in ["switchback:short", "switchback:ext", "switchback:difficulty", "switchback:minutes"] {
            t.tags[tag] = nil
        }
        return t
    }

    private static func json(_ text: String?) -> [[String: Any]]? {
        guard let data = text?.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]
    }

    /// This trail as the hike you'd actually walk: in from a trailhead (and back out, for a loop), with any side
    /// loops added. The map, the length and navigation all follow it.
    func hike(from access: TrailAccess?, adding added: [TrailExtension]) -> Trail {
        var t = self
        var route = path
        // the elevation follows the route as long as every part has its own; otherwise it stays the trail's
        var chart = profile
        func nearest(_ c: Coord) -> Int {
            route.indices.min { Geo.distance(route[$0], c) < Geo.distance(route[$1], c) } ?? 0
        }
        /// How far along the route a point of it is, on the chart's scale.
        func along(_ i: Int) -> Double {
            var d = 0.0, whole = 0.0
            for k in 1..<max(1, route.count) {
                let step = Geo.distance(route[k - 1], route[k])
                whole += step
                if k <= i { d += step }
            }
            return whole > 0 ? d / whole * (chart?.total ?? 0) : 0
        }
        for e in added where e.line.count > 1 {
            let at = nearest(e.line[0])
            if let c = chart, let p = e.profile { chart = c.inserting(p, at: along(at)) } else { chart = nil }
            route.insert(contentsOf: e.line, at: at + 1)
            t.segments.append(e.line)
            t.length += e.length
        }
        if let a = access, route.count > 1 {
            // a trailhead on the trail has no walk in: the hike just starts there
            let walk = a.line.count > 1 ? a.line : []
            let join = walk.last ?? a.point
            if isLoop {
                let i = nearest(join)
                if i > 0 {
                    chart = chart?.rotated(to: along(i))
                    route = Array(route[i...]) + Array(route[1...i])
                }
            } else if Geo.distance(route[route.count - 1], join) < Geo.distance(route[0], join) {
                chart = chart?.backwards
                route.reverse()
            }
            // The trail's own walk out to another trailhead and back isn't part of a hike that starts here.
            var trimmed = false
            for other in accessPoints where other.id != a.id && other.distance <= Self.ownAccess {
                let k = nearest(other.point)
                guard Geo.distance(route[k], other.point) <= Self.ownAccess else { continue }
                let found = (max(1, k - 2)...max(1, min(route.count - 2, k + 2))).compactMap { Self.stem(of: route, turningAt: $0) }
                guard let (from, to) = found.max(by: { $0.1 - $0.0 < $1.1 - $1.0 }) else { continue }
                let gone = Geo.length(Array(route[from...to]))
                guard gone >= 80, gone < Geo.length(route) / 2 else { continue }
                chart = chart?.removing(from: along(from), to: along(to))
                route.removeSubrange((from + 1)...to)
                t.length -= gone
                trimmed = true
            }
            if trimmed { t.segments = [route] }
            if !walk.isEmpty {
                if let c = chart, let p = a.profile {
                    chart = isLoop ? p.then(c).then(p.backwards) : p.then(c)
                } else {
                    chart = nil
                }
                route = walk + route
                if isLoop { route += walk.reversed() }
                t.length += (isLoop ? 2 : 1) * a.distance
                t.segments.append(walk)
            }
        }
        t.path = route
        t.profile = chart ?? profile
        t.tags["switchback:chart"] = chart == nil && t.length != length ? "trail" : nil
        if t.length != length {
            // the file's difficulty and time are for the trail on its own, not with the walk in or a side loop
            t.tags["switchback:difficulty"] = nil
            t.tags["switchback:minutes"] = nil
        }
        return t
    }

    /// A trailhead this close to the trail (metres of walking) is one of the trail's own.
    static let ownAccess = 150.0

    /// The out-and-back stretch of a route that turns round at point `k`: where it leaves the rest of the route and
    /// where it is back there, if the two ways really run along each other.
    static func stem(of route: [Coord], turningAt k: Int) -> (Int, Int)? {
        let near = 15.0
        var i = k, j = k, out = 0.0, back = 0.0
        var best: (Int, Int)?
        while i > 0, j < route.count - 1 {
            let nextOut = out + Geo.distance(route[i], route[i - 1])
            let nextBack = back + Geo.distance(route[j], route[j + 1])
            if nextOut <= nextBack {
                guard Geo.project(route[i - 1], route[j], route[j + 1]).distance <= near else { break }
                i -= 1
                out = nextOut
            } else {
                guard Geo.project(route[j + 1], route[i], route[i - 1]).distance <= near else { break }
                j += 1
                back = nextBack
            }
            if Geo.distance(route[i], route[j]) <= near { best = (i, j) }
        }
        return best
    }

    /// The trailhead a hike starts from unless another is picked: one of the trail's own (the one named after it,
    /// else the one nearest you), and only when it has none, the shortest walk in.
    func defaultAccess(near here: Coord?) -> TrailAccess? {
        let points = accessPoints
        let own = points.filter { $0.distance <= Self.ownAccess }
        guard !own.isEmpty else { return points.first }
        func bare(_ s: String) -> String {
            var s = s.lowercased()
            for word in ["trailhead", "trail head", "trail"] { s = s.replacingOccurrences(of: word, with: "") }
            return s.trimmingCharacters(in: .whitespaces)
        }
        if let named = own.first(where: { bare($0.name) == bare(name) }) { return named }
        guard let here else { return own.first }
        return own.min { Geo.distance(here, $0.point) < Geo.distance(here, $1.point) }
    }

    static let informalKey = "informalTrails"
    static var showsInformal: Bool { UserDefaults.standard.bool(forKey: informalKey) }

    var difficulty: Difficulty {
        // trail files say (scripts/enrich_trail_pack.py, rate); anything else is worked out here by the same rule
        if let said = tags["switchback:difficulty"].flatMap(Difficulty.init(rawValue:)) { return said }
        let km = length / 1000
        let effort = km + (profile?.gain ?? 0) / 100
        var level: Difficulty = effort < 8 ? .easy : effort < 16 ? .moderate : effort < 26 ? .hard : .veryHard
        // Forest Service class 1 (minimally developed) trails are rough going
        if tags["usfs:trail_class"]?.filter(\.isNumber) == "1" { level = max(level, .moderate) }
        switch tags["sac_scale"] {
        case "mountain_hiking": level = max(level, .moderate)
        case "demanding_mountain_hiking": level = max(level, .hard)
        case "alpine_hiking", "demanding_alpine_hiking", "difficult_alpine_hiking": level = .veryHard
        default: break
        }
        return level
    }

    /// Naismith's rule at an easy pace: 4.5 km/h plus an hour for every 600 m of climb.
    var estimatedDuration: TimeInterval {
        if let minutes = tags["switchback:minutes"].flatMap(Double.init) { return minutes * 60 }
        return (length / 1000 / 4.5 + (profile?.gain ?? 0) / 600) * 3600
    }

    var osmURL: URL? {
        guard let osmId else { return nil }
        switch source {
        case .osmRelation: return URL(string: "https://www.openstreetmap.org/relation/\(osmId)")
        case .osmWay: return URL(string: "https://www.openstreetmap.org/way/\(osmId)")
        default: return nil
        }
    }

    var summary: String? { tags["description"] ?? tags["description:en"] ?? tags["note"] }

    /// Facts from the OpenStreetMap tags worth showing, in a friendly form.
    var facts: [TrailFact] {
        var out: [TrailFact] = []
        if let from = tags["from"], let to = tags["to"] { out.append(TrailFact(title: "Route", value: "\(from) → \(to)")) }
        if let network = tags["network"] {
            let names = ["lwn": "Local", "rwn": "Regional", "nwn": "National", "iwn": "International"]
            out.append(TrailFact(title: "Network", value: names[network] ?? network))
        }
        if let op = tags["operator"] { out.append(TrailFact(title: "Managed by", value: op)) }
        if let sac = tags["sac_scale"] {
            let names = [
                "hiking": "T1 · Hiking",
                "mountain_hiking": "T2 · Mountain hiking",
                "demanding_mountain_hiking": "T3 · Demanding mountain hiking",
                "alpine_hiking": "T4 · Alpine hiking",
                "demanding_alpine_hiking": "T5 · Demanding alpine hiking",
                "difficult_alpine_hiking": "T6 · Difficult alpine hiking",
            ]
            out.append(TrailFact(title: "SAC scale", value: names[sac] ?? sac))
        }
        if tags["switchback:multiuse"] == "yes" { out.append(TrailFact(title: "Type", value: "Multi-use path (walking and cycling)")) }
        if let surface = tags["surface"] { out.append(TrailFact(title: "Surface", value: surface.replacingOccurrences(of: "_", with: " ").capitalized)) }
        if let vis = tags["trail_visibility"] { out.append(TrailFact(title: "Trail visibility", value: vis.capitalized)) }
        if let ref = tags["ref"] { out.append(TrailFact(title: "Ref", value: ref)) }
        if let symbol = tags["symbol"] { out.append(TrailFact(title: "Waymarks", value: symbol)) }
        if let cls = tags["usfs:trail_class"] {
            let digits = cls.filter(\.isNumber)
            let names = ["1": "TC1 · Minimally developed", "2": "TC2 · Moderately developed", "3": "TC3 · Developed",
                         "4": "TC4 · Highly developed", "5": "TC5 · Fully developed"]
            out.append(TrailFact(title: "Forest Service class", value: names[digits] ?? cls))
        }
        if let surface = tags["usfs:surface"], tags["surface"] == nil {
            out.append(TrailFact(title: "Surface", value: surface.replacingOccurrences(of: "_", with: " ").capitalized))
        }
        if let grade = tags["usfs:grade"] { out.append(TrailFact(title: "Typical grade", value: grade)) }
        if let nat = tags["usfs:national"] { out.append(TrailFact(title: "National designation", value: nat.capitalized)) }
        if let dogs = tags["dog"] { out.append(TrailFact(title: "Dogs", value: dogs.capitalized)) }
        if let source = tags["official:source"] {
            let ref = tags["official:ref"].map { " #\($0)" } ?? ""
            let name = tags["official:name"].map { "\($0)\(ref) · " } ?? (ref.isEmpty ? "" : "\(ref.dropFirst()) · ")
            out.append(TrailFact(title: "Official record", value: "\(name)\(source)"))
            if let match = tags["official:match"] { out.append(TrailFact(title: "Match", value: match)) }
            if let miles = tags["official:miles"].flatMap(Double.init) {
                out.append(TrailFact(title: "Official length", value: Fmt.distance(miles * 1609.344)))
            }
        }
        if isInformal, let why = tags["switchback:informal_reason"] {
            out.append(TrailFact(title: "Informal", value: why))
        }
        // pieces of this trail were joined along the route drawn over them (often a road between two sections)
        if let m = tags["switchback:bridged"].flatMap(Double.init), m > 0 {
            out.append(TrailFact(title: "Joined sections", value: "\(Fmt.distance(m)) follows roads or unnamed stretches between the mapped sections"))
        }
        return out
    }

    var website: URL? {
        (tags["website"] ?? tags["url"]).flatMap { URL(string: $0) }
    }
}

/// A trailhead or car park a trail can be started from.
struct TrailAccess: Hashable, Identifiable {
    let name: String
    /// The walk from here to the trail, one way, in metres.
    let distance: Double
    let point: Coord
    /// The way in, from the trailhead to the trail (empty when the trailhead is on the trail).
    let line: [Coord]
    /// Elevation along the way in.
    var profile: ElevationProfile? = nil
    /// The named trails the way in follows, in the order walked (at most two; trail files say which).
    var via: [String] = []

    var id: String { "\(name)|\(point.lat)|\(point.lon)" }

    /// "via Ridge Trail and Creek Trail", when the way in follows named trails.
    var viaText: String? { via.isEmpty ? nil : "via " + via.joined(separator: " and ") }

    /// A trailhead with a name of its own, not a car park named after the trail beside it ("Parking on …").
    var isNamed: Bool { name != "Parking" && !name.hasPrefix("Parking on ") }

    /// The line under a hike's title: "From Camp Five Pond Trailhead via Ridge Trail" (either half alone, or nothing).
    var startLine: String? {
        let line = [isNamed ? "from \(name)" : nil, viaText].compactMap { $0 }.joined(separator: " ")
        return line.isEmpty ? nil : line.prefix(1).uppercased() + String(line.dropFirst())
    }
}

/// A loop that hangs off another loop and can be added to it.
struct TrailExtension: Hashable, Identifiable {
    let id: String
    let name: String
    let length: Double
    /// The side loop, starting and ending at the junction.
    let line: [Coord]
    var profile: ElevationProfile? = nil
}

/// A trail system: a named trail with its loops, sections and side trails ("Cedar Creek Trail").
struct TrailSystem: Hashable, Identifiable {
    let name: String
    let trails: [Trail]

    var id: String { name }
    static func == (a: TrailSystem, b: TrailSystem) -> Bool { a.name == b.name && a.trails.map(\.id) == b.trails.map(\.id) }
    func hash(into hasher: inout Hasher) { hasher.combine(name) }
}
