// The live call's Live Activity: started first thing in a call (an AudioRecordingIntent must show
// one while it records), updated with the call's state and latest words (at most about once a
// second), ended with the call and dismissed a few seconds later.

import ActivityKit
import Foundation

@MainActor
final class LiveCallActivity {
  private var activity: Activity<LiveCallAttributes>?
  private var latest: LiveCallAttributes.ContentState?
  private var lastSent = Date.distantPast
  private var flush: Task<Void, Never>?
  private static let minInterval: TimeInterval = 0.8

  func start(agent: String, agentName: String, startedAt: Date) {
    endStale()
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    let state = LiveCallAttributes.ContentState(state: "connecting", line: "", startedAt: startedAt)
    do {
      activity = try Activity.request(
        attributes: LiveCallAttributes(agent: agent, agentName: agentName),
        content: ActivityContent(state: state, staleDate: nil),
        pushType: nil
      )
      latest = state
      lastSent = Date()
    } catch {
      NSLog("[LiveCall] Live Activity not started: \(error.localizedDescription)")
      activity = nil
    }
  }

  func update(state: String, line: String, startedAt: Date) {
    guard activity != nil else { return }
    let next = LiveCallAttributes.ContentState(state: state, line: line, startedAt: startedAt)
    guard next != latest else { return }
    latest = next
    let wait = Self.minInterval - Date().timeIntervalSince(lastSent)
    if wait <= 0 {
      send()
    } else if flush == nil {
      flush = Task { @MainActor [weak self] in
        try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
        guard let self, !Task.isCancelled else { return }
        self.flush = nil
        self.send()
      }
    }
  }

  func end(line: String, startedAt: Date) {
    flush?.cancel()
    flush = nil
    guard let activity else { return }
    self.activity = nil
    latest = nil
    let final = LiveCallAttributes.ContentState(state: "ended", line: line, startedAt: startedAt)
    Task {
      await activity.end(ActivityContent(state: final, staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(3)))
    }
  }

  /// Live Activities a crashed or killed call left behind.
  func endStale() {
    for stale in Activity<LiveCallAttributes>.activities where stale.id != activity?.id {
      Task { await stale.end(nil, dismissalPolicy: .immediate) }
    }
  }

  private func send() {
    guard let activity, let latest else { return }
    lastSent = Date()
    Task { await activity.update(ActivityContent(state: latest, staleDate: nil)) }
  }
}
