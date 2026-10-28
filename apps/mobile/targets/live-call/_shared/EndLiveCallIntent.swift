// The End button of the live call's Live Activity. In both the app and the widget extension (the
// widget needs the type to draw `Button(intent:)`); as a LiveActivityIntent it always runs in the
// app's process, where RELAY_APP is defined and the LiveCall engine is linked.

import AppIntents
#if RELAY_APP
import LiveCall
#endif

struct EndLiveCallIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "End Live Call"
  static let isDiscoverable = false

  init() {}

  func perform() async throws -> some IntentResult {
    #if RELAY_APP
    await LiveCallEngine.shared.end()
    #endif
    return .result()
  }
}
