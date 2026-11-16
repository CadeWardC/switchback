import CoreLocation
import UIKit

/// Which way the phone points, for the arrow on the Apple map's location dot (our own map draws its own).
/// Runs only while the app is on screen.
@MainActor
final class Compass: NSObject, CLLocationManagerDelegate {
    static let shared = Compass()
    static let changed = Notification.Name("SwitchbackCompassChanged")

    /// Degrees clockwise from true north, once known.
    private(set) var heading: Double?
    private let manager = CLLocationManager()
    private var started = false

    override init() {
        super.init()
        manager.delegate = self
        manager.headingFilter = 2
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(pause), name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(resume), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    func start() {
        guard !started, CLLocationManager.headingAvailable() else { return }
        started = true
        manager.startUpdatingHeading()
    }

    @objc private func pause() {
        if started { manager.stopUpdatingHeading() }
    }

    @objc private func resume() {
        if started { manager.startUpdatingHeading() }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        guard newHeading.headingAccuracy >= 0 else { return }
        let value = newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
        Task { @MainActor in
            self.heading = value
            NotificationCenter.default.post(name: Self.changed, object: nil)
        }
    }

    nonisolated func locationManagerShouldDisplayHeadingCalibration(_ manager: CLLocationManager) -> Bool { true }
}
