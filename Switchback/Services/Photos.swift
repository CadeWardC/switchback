import CryptoKit
import MapKit
import Photos
import UIKit

/// Satellite pictures of a trail with its route drawn on, made by MapKit and kept on disk.
@MainActor
final class Snapshots {
    static let shared = Snapshots()

    private let memory = NSCache<NSString, UIImage>()
    private let dir = Files.caches.appendingPathComponent("Snapshots", isDirectory: true)
    private var active = 0
    private var waiting: [CheckedContinuation<Void, Never>] = []

    private func key(_ trail: Trail, _ size: CGSize) -> String {
        let raw = "\(trail.id)|\(Int(size.width))x\(Int(size.height))|\(trail.path.count)"
        return SHA256.hash(data: Data(raw.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    func cached(for trail: Trail, size: CGSize) -> UIImage? {
        memory.object(forKey: key(trail, size) as NSString)
    }

    func image(for trail: Trail, size: CGSize) async -> UIImage? {
        let k = key(trail, size)
        if let img = memory.object(forKey: k as NSString) { return img }
        let file = dir.appendingPathComponent(k + ".jpg")
        if let data = try? Data(contentsOf: file), let img = UIImage(data: data) {
            memory.setObject(img, forKey: k as NSString)
            return img
        }
        // two at a time, so a scrolling list doesn't start dozens
        if active >= 2 {
            await withCheckedContinuation { waiting.append($0) }
        }
        active += 1
        defer {
            active -= 1
            if !waiting.isEmpty { waiting.removeFirst().resume() }
        }
        if Task.isCancelled { return nil }
        guard let img = await render(trail, size: size) else { return nil }
        memory.setObject(img, forKey: k as NSString)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? img.jpegData(compressionQuality: 0.82)?.write(to: file)
        return img
    }

    private func render(_ trail: Trail, size: CGSize) async -> UIImage? {
        let options = MKMapSnapshotter.Options()
        let box = trail.bbox
        // square-ish framing around the route, with some room
        let span = max(box.latSpan, box.lonSpan * cos(box.center.lat * .pi / 180), 0.004) * 1.35
        let aspect = Double(size.width / max(1, size.height))
        options.region = MKCoordinateRegion(center: box.center.cl,
                                            span: MKCoordinateSpan(latitudeDelta: span / min(1, aspect),
                                                                   longitudeDelta: span * max(1, aspect) / cos(box.center.lat * .pi / 180)))
        options.size = size
        options.preferredConfiguration = MKImageryMapConfiguration(elevationStyle: .flat)
        guard let snapshot = try? await MKMapSnapshotter(options: options).start() else { return nil }
        let renderer = UIGraphicsImageRenderer(size: size)
        let color = trail.difficulty.mapColor
        return renderer.image { ctx in
            snapshot.image.draw(at: .zero)
            let path = UIBezierPath()
            for seg in trail.segments {
                for (i, c) in seg.enumerated() {
                    let p = snapshot.point(for: c.cl)
                    if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
                }
            }
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            let base = max(2, min(size.width, size.height) / 60)
            UIColor.white.setStroke()
            path.lineWidth = base * 2
            path.stroke()
            color.setStroke()
            path.lineWidth = base
            path.stroke()
            let s = snapshot.point(for: trail.start.cl)
            let r = base * 1.8
            UIColor.white.setFill()
            UIBezierPath(ovalIn: CGRect(x: s.x - r - 1.5, y: s.y - r - 1.5, width: 2 * r + 3, height: 2 * r + 3)).fill()
            color.setFill()
            UIBezierPath(ovalIn: CGRect(x: s.x - r, y: s.y - r, width: 2 * r, height: 2 * r)).fill()
            _ = ctx
        }
    }
}

/// Your own photos taken during a hike, from the photo library (they never leave the phone).
struct HikePhoto: Identifiable, Hashable {
    let id: String
    let asset: PHAsset
    let coord: Coord?
    let date: Date
}

enum HikePhotos {
    static var isAuthorized: Bool {
        let s = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        return s == .authorized || s == .limited
    }

    static func requestAccess() async -> Bool {
        let s = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        return s == .authorized || s == .limited
    }

    static func photos(for activity: Activity) -> [HikePhoto] {
        let options = PHFetchOptions()
        options.predicate = NSPredicate(format: "mediaType == %d AND creationDate >= %@ AND creationDate <= %@",
                                        PHAssetMediaType.image.rawValue,
                                        activity.start.addingTimeInterval(-60) as NSDate,
                                        activity.end.addingTimeInterval(60) as NSDate)
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        let result = PHAsset.fetchAssets(with: options)
        let points = activity.segments.flatMap { $0 }
        var out: [HikePhoto] = []
        result.enumerateObjects { asset, _, _ in
            let date = asset.creationDate ?? activity.start
            let coord = asset.location.map { Coord($0.coordinate) } ?? position(at: date, in: points)
            out.append(HikePhoto(id: asset.localIdentifier, asset: asset, coord: coord, date: date))
        }
        return out
    }

    /// Where you were at a time, from the recorded track (for photos without a location).
    private static func position(at date: Date, in points: [TrackPoint]) -> Coord? {
        guard let first = points.first else { return nil }
        if date <= first.time { return first.coord }
        for i in 1..<max(1, points.count) {
            let a = points[i - 1], b = points[i]
            if date <= b.time {
                let span = b.time.timeIntervalSince(a.time)
                let t = span > 0 ? date.timeIntervalSince(a.time) / span : 0
                return Coord(lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t)
            }
        }
        return points.last?.coord
    }

    static func image(_ asset: PHAsset, size: CGSize) async -> UIImage? {
        await withCheckedContinuation { cont in
            let options = PHImageRequestOptions()
            options.deliveryMode = .highQualityFormat
            options.isNetworkAccessAllowed = true
            options.resizeMode = .fast
            PHImageManager.default().requestImage(for: asset, targetSize: size, contentMode: .aspectFill, options: options) { img, _ in
                cont.resume(returning: img)
            }
        }
    }
}
