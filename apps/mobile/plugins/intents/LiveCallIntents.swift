// "Talk to Nova" / "Talk to Astra": one press of the Action Button (or a Shortcut, Siri, Spotlight)
// starts a live call with that assistant, from the lock screen too; pressing again ends it.
// Copied into the app target by plugins/withLiveCallIntents.js (source of truth: plugins/intents/).
//
// AudioRecordingIntent lets them keep the microphone in the background as long as the call shows a
// Live Activity, which LiveCallEngine starts before anything else; LiveActivityIntent is what lets
// that Live Activity start while Relay is not in the foreground (Shortcuts, Spotlight, Siri).
// When the live call cannot go live (no GPT-Live on the host, host unreachable) the engine leaves
// a pending fallback and the intent asks to continue in Relay, whose JS then starts the regular call.

import AppIntents
import LiveCall

struct TalkToNovaIntent: AudioRecordingIntent, LiveActivityIntent, ForegroundContinuableIntent {
  static let title: LocalizedStringResource = "Talk to Nova"
  static let description = IntentDescription("Starts a live voice conversation with Nova, or ends the one running.")

  @MainActor
  func perform() async throws -> some IntentResult {
    try await talk(to: "nova", from: self)
    return .result()
  }
}

struct TalkToAstraIntent: AudioRecordingIntent, LiveActivityIntent, ForegroundContinuableIntent {
  static let title: LocalizedStringResource = "Talk to Astra"
  static let description = IntentDescription("Starts a live voice conversation with Astra, or ends the one running.")

  @MainActor
  func perform() async throws -> some IntentResult {
    try await talk(to: "astra", from: self)
    return .result()
  }
}

struct RelayShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: TalkToNovaIntent(),
      phrases: ["Talk to Nova in \(.applicationName)", "Call Nova in \(.applicationName)"],
      shortTitle: "Talk to Nova",
      systemImageName: "sparkles"
    )
    AppShortcut(
      intent: TalkToAstraIntent(),
      phrases: ["Talk to Astra in \(.applicationName)", "Call Astra in \(.applicationName)"],
      shortTitle: "Talk to Astra",
      systemImageName: "moon.stars"
    )
  }
}

private struct LiveCallIntentError: Error, CustomLocalizedStringResourceConvertible {
  let message: String
  var localizedStringResource: LocalizedStringResource { "\(message)" }
}

/// Ends the call with `agent` if one is running, else starts one and waits until it is live.
@MainActor
private func talk(to agent: String, from intent: some ForegroundContinuableIntent) async throws {
  guard let outcome = await LiveCallEngine.shared.toggle(agent: agent) else { return }
  switch outcome {
  case .live, .ended:
    return
  case .fallback:
    // The pending fallback is stored; Relay starts the regular call once it is open. Declined,
    // it must not start one the next time Relay happens to open.
    let name = LiveCallEngine.displayName(of: agent)
    do {
      try await intent.requestToContinueInForeground(IntentDialog("Live calls aren't available right now. Open Relay to call \(name)?")) {}
    } catch {
      LiveCallEngine.shared.discardPendingFallback()
      throw error
    }
  case .failed(let message):
    throw LiveCallIntentError(message: message)
  }
}
