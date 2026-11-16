// The hike on the lock screen and in the Dynamic Island: how far you have walked and how long you have
// been out, large; under them what is left and when you will be back (while a trail is followed), or how
// far off the trail you are.
import ActivityKit
import SwiftUI
import WidgetKit

@main
struct SwitchbackHikeBundle: WidgetBundle {
  var body: some Widget {
    HikeLiveActivity()
  }
}

private let green = Color(red: 0.42, green: 0.84, blue: 0.60)
private let yellow = Color(red: 0.96, green: 0.77, blue: 0.19)

struct HikeLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: HikeAttributes.self) { context in
      LockScreenHike(name: context.attributes.name, state: context.state)
        .activityBackgroundTint(Color(red: 0.05, green: 0.08, blue: 0.07).opacity(0.85))
        .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      let s = context.state
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          VStack(alignment: .leading, spacing: 2) {
            Text(s.walked).font(.title2.bold().monospacedDigit())
            Text("walked").font(.caption2).foregroundStyle(.secondary)
          }
          .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          VStack(alignment: .trailing, spacing: 2) {
            TimeOut(started: s.started).font(.title2.bold().monospacedDigit()).multilineTextAlignment(.trailing)
            Text(s.paused ? "on the trail, paused" : "on the trail").font(.caption2).foregroundStyle(.secondary)
          }
          .padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.bottom) {
          Ahead(state: s).font(.caption.weight(.semibold))
        }
      } compactLeading: {
        Image(systemName: s.offTrail != nil ? "exclamationmark.triangle.fill" : "figure.hiking")
          .foregroundStyle(s.offTrail != nil ? yellow : green)
      } compactTrailing: {
        Text(s.walked).font(.caption.bold().monospacedDigit())
      } minimal: {
        Image(systemName: s.offTrail != nil ? "exclamationmark.triangle.fill" : "figure.hiking")
          .foregroundStyle(s.offTrail != nil ? yellow : green)
      }
    }
  }
}

/// The time on the trail, counting up by itself.
private struct TimeOut: View {
  let started: Date

  var body: some View {
    Text(timerInterval: started...Date.distantFuture, countsDown: false)
  }
}

/// One line: off the trail, or what is left and when you will be back.
private struct Ahead: View {
  let state: HikeAttributes.ContentState

  var body: some View {
    if let off = state.offTrail {
      Label("Off the trail: \(off)", systemImage: "exclamationmark.triangle.fill")
        .foregroundStyle(yellow)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    } else if let left = state.left {
      HStack(spacing: 6) {
        Text("\(left) \((state.leftLabel ?? "Left").lowercased())")
        if let back = state.backBy {
          Spacer(minLength: 8)
          Text("back by \(back)")
        }
      }
      .lineLimit(1)
      .minimumScaleFactor(0.8)
    }
  }
}

private struct LockScreenHike: View {
  let name: String
  let state: HikeAttributes.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Image(systemName: "figure.hiking").foregroundStyle(green)
        Text(name).font(.subheadline.weight(.semibold)).lineLimit(1)
        Spacer()
        if state.paused {
          Text("Paused").font(.caption.bold()).foregroundStyle(yellow)
        }
      }
      HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading, spacing: 0) {
          Text(state.walked).font(.system(size: 34, weight: .bold, design: .rounded).monospacedDigit())
          Text("walked").font(.caption).foregroundStyle(.white.opacity(0.7))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        VStack(alignment: .leading, spacing: 0) {
          TimeOut(started: state.started).font(.system(size: 34, weight: .bold, design: .rounded).monospacedDigit())
          Text("on the trail").font(.caption).foregroundStyle(.white.opacity(0.7))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      Ahead(state: state).font(.footnote.weight(.semibold))
    }
    .foregroundStyle(.white)
    .padding(16)
  }
}
