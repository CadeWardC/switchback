// What the lock screen shows during a hike. This file is kept the same in two places, because the app's
// module and the widget are built separately and must agree on it:
//   modules/hike-activity/ios/HikeAttributes.swift   (the app starts and updates the activity)
//   targets/hike/HikeAttributes.swift                (the widget draws it)
// The words and numbers arrive ready to show (the app writes them in the person's units).
import ActivityKit
import Foundation

struct HikeAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    /// "1.4 mi"
    var walked: String
    /// When the hike began: the time on the trail counts up from it by itself.
    var started: Date
    var paused: Bool
    /// While a trail is followed: "0.8 mi", what that is ("Left", "Left, out and back",
    /// "Back to your start") and the time you would be done ("2:48").
    var left: String?
    var leftLabel: String?
    var backBy: String?
    /// While off the trail: "200 ft to your right".
    var offTrail: String?
  }

  /// The trail being followed, or "Your hike".
  var name: String
}
