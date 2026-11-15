// The app's side of the hike on the lock screen: starts the Live Activity, changes what it shows, ends it.
// JavaScript: src/platform/liveActivity.ts. The widget that draws it: targets/hike.
import ActivityKit
import ExpoModulesCore

internal struct HikeStateRecord: Record {
  @Field var walked: String = ""
  /// Milliseconds since 1970.
  @Field var started: Double = 0
  @Field var paused: Bool = false
  @Field var left: String?
  @Field var leftLabel: String?
  @Field var backBy: String?
  @Field var offTrail: String?
}

public class HikeActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HikeActivity")

    // Shows the hike, or changes what is shown. Resolves to whether there is an activity on the lock screen.
    AsyncFunction("update") { (name: String, state: HikeStateRecord) -> Bool in
      let content = HikeAttributes.ContentState(
        walked: state.walked,
        started: Date(timeIntervalSince1970: state.started / 1000),
        paused: state.paused,
        left: state.left,
        leftLabel: state.leftLabel,
        backBy: state.backBy,
        offTrail: state.offTrail
      )
      return await HikeActivityCenter.shared.show(name: name, state: content)
    }

    AsyncFunction("end") {
      await HikeActivityCenter.shared.end()
    }
  }
}

/// One hike at a time. An activity left from before the app was restarted is taken up again.
internal actor HikeActivityCenter {
  static let shared = HikeActivityCenter()

  func show(name: String, state: HikeAttributes.ContentState) async -> Bool {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return false }
    let content = ActivityContent(state: state, staleDate: nil)
    var shown = false
    for activity in Activity<HikeAttributes>.activities {
      if !shown && activity.attributes.name == name {
        await activity.update(content)
        shown = true
      } else {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }
    if shown { return true }
    // (the system only allows a new one while the app is on screen)
    do {
      _ = try Activity<HikeAttributes>.request(attributes: HikeAttributes(name: name), content: content, pushType: nil)
      return true
    } catch {
      return false
    }
  }

  func end() async {
    for activity in Activity<HikeAttributes>.activities {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }
}
