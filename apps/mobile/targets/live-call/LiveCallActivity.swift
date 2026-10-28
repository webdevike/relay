// What a live call shows outside the app: the lock screen banner (assistant, state, the latest
// words, elapsed time, End) and the Dynamic Island. LiveCallEngine (modules/live-call) starts,
// updates and ends the activity; End runs EndLiveCallIntent in the app.

import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct LiveCallWidgets: WidgetBundle {
  var body: some Widget {
    LiveCallLiveActivity()
  }
}

/// Relay's accent (theme.ts `accent`, dark).
private let accent = Color(red: 0x7C / 255, green: 0x9C / 255, blue: 0xFF / 255)

private extension LiveCallAttributes.ContentState {
  var ended: Bool { state == "ended" }

  func label(_ name: String) -> String {
    switch state {
    case "connecting": return "Connecting…"
    case "listening": return "Listening"
    case "thinking": return "\(name) is thinking…"
    case "speaking": return "Speaking"
    case "ended": return "Call ended"
    default: return state
    }
  }

  var symbol: String {
    switch state {
    case "thinking": return "ellipsis.bubble"
    case "ended": return "phone.down"
    default: return "waveform"
    }
  }
}

private struct Elapsed: View {
  let state: LiveCallAttributes.ContentState

  var body: some View {
    if state.ended {
      Text("Ended")
    } else {
      Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false)
        .monospacedDigit()
    }
  }
}

private struct EndButton: View {
  var body: some View {
    Button(intent: EndLiveCallIntent()) {
      Label("End", systemImage: "phone.down.fill")
        .font(.subheadline.weight(.semibold))
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.borderedProminent)
    .tint(.red)
  }
}

private struct LockScreenBanner: View {
  let context: ActivityViewContext<LiveCallAttributes>

  var body: some View {
    let state = context.state
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .center, spacing: 12) {
        Image(systemName: state.symbol)
          .font(.title2.weight(.semibold))
          .foregroundStyle(accent)
          .frame(width: 32)
        VStack(alignment: .leading, spacing: 2) {
          Text(context.attributes.agentName)
            .font(.headline)
          Text(state.label(context.attributes.agentName))
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        Spacer(minLength: 8)
        Elapsed(state: state)
          .font(.subheadline.weight(.medium))
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.trailing)
          .frame(maxWidth: 64, alignment: .trailing)
      }
      if !state.line.isEmpty {
        Text(state.line)
          .font(.subheadline)
          .lineLimit(2)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      if !state.ended {
        EndButton()
      }
    }
    .padding(16)
  }
}

struct LiveCallLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: LiveCallAttributes.self) { context in
      LockScreenBanner(context: context)
        .activitySystemActionForegroundColor(accent)
    } dynamicIsland: { context in
      let state = context.state
      let name = context.attributes.agentName
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Label {
            Text(name).font(.headline)
          } icon: {
            Image(systemName: state.symbol).foregroundStyle(accent)
          }
          .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Elapsed(state: state)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.trailing)
            .frame(maxWidth: 64, alignment: .trailing)
            .padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 8) {
            Text(state.line.isEmpty ? state.label(name) : state.line)
              .font(.subheadline)
              .lineLimit(2)
              .frame(maxWidth: .infinity, alignment: .leading)
            if !state.ended {
              EndButton()
            }
          }
        }
      } compactLeading: {
        Image(systemName: state.symbol)
          .foregroundStyle(accent)
      } compactTrailing: {
        if state.state == "connecting" || state.state == "thinking" || state.ended {
          Image(systemName: state.ended ? "phone.down.fill" : "ellipsis")
            .foregroundStyle(accent)
        } else {
          Elapsed(state: state)
            .frame(maxWidth: 44)
            .foregroundStyle(accent)
        }
      } minimal: {
        Image(systemName: "waveform")
          .foregroundStyle(accent)
      }
      .keylineTint(accent)
    }
  }
}
