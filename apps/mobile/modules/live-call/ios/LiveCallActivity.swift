// The live call's Live Activity: started first thing in a call (an AudioRecordingIntent must show
// one while it records), updated with the call's state and latest words (at most about once a
// second), ended with the call and dismissed a few seconds later.
//
// Every content carries a stale date `staleAfter` ahead, pushed forward by `keepAlive` while the
// call runs; an app that is killed or suspended mid-call stops pushing it, and the widget then
// draws "Disconnected" with no running timer instead of a call that looks live. Activities no
// running call owns are ended at launch (`endAll`), when End is tapped with no call, and when the
// app terminates.

import ActivityKit
import Foundation

@MainActor
final class LiveCallActivity {
  private var activity: Activity<LiveCallAttributes>?
  private var latest: LiveCallAttributes.ContentState?
  private var lastSent = Date.distantPast
  private var flush: Task<Void, Never>?
  private static let minInterval: TimeInterval = 0.8
  /// How far ahead each content's stale date is.
  private static let staleAfter: TimeInterval = 45
  /// `keepAlive` re-sends the content once the last send is this old.
  private static let refreshAfter: TimeInterval = 15

  func start(agent: String, agentName: String, startedAt: Date) {
    endStale()
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    let state = LiveCallAttributes.ContentState(state: "connecting", line: "", startedAt: startedAt)
    do {
      activity = try Activity.request(
        attributes: LiveCallAttributes(agent: agent, agentName: agentName),
        content: Self.content(state),
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

  /// Moves the stale date forward while the call is alive (called by the engine's watchdog).
  func keepAlive() {
    guard activity != nil, flush == nil, Date().timeIntervalSince(lastSent) >= Self.refreshAfter else { return }
    send()
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

  /// Live Activities a crashed or killed call left behind (every one but the current call's).
  func endStale() {
    for stale in Activity<LiveCallAttributes>.activities where stale.id != activity?.id {
      Task { await stale.end(nil, dismissalPolicy: .immediate) }
    }
  }

  /// Every live call activity, the current one too: there is no call to show.
  func endAll() {
    flush?.cancel()
    flush = nil
    activity = nil
    latest = nil
    let all = Activity<LiveCallAttributes>.activities
    if !all.isEmpty { NSLog("[LiveCall] ending \(all.count) orphaned Live Activit\(all.count == 1 ? "y" : "ies")") }
    for orphan in all {
      Task { await orphan.end(nil, dismissalPolicy: .immediate) }
    }
  }

  /// `endAll` for the app's last moments (termination): waits up to `seconds` for the ends to land.
  func endAllBeforeExit(seconds: Double) {
    flush?.cancel()
    flush = nil
    activity = nil
    latest = nil
    let all = Activity<LiveCallAttributes>.activities
    guard !all.isEmpty else { return }
    let done = DispatchSemaphore(value: 0)
    Task.detached {
      for orphan in all { await orphan.end(nil, dismissalPolicy: .immediate) }
      done.signal()
    }
    _ = done.wait(timeout: .now() + seconds)
  }

  private func send() {
    guard let activity, let latest else { return }
    lastSent = Date()
    Task { await activity.update(Self.content(latest)) }
  }

  private static func content(_ state: LiveCallAttributes.ContentState) -> ActivityContent<LiveCallAttributes.ContentState> {
    ActivityContent(state: state, staleDate: Date().addingTimeInterval(staleAfter))
  }
}
