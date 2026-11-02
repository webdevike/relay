import Cocoa

// Relay Buddy: a cursor helper that points at things on screen.
//
// CLI:
//   RelayBuddy                          run the menu-bar app
//   RelayBuddy --ask "q" [--target app] run the app and ask "q" once it is up
//   RelayBuddy --send "q" [--target app] ask a running instance, then exit
//   RelayBuddy --summon                 open the prompt bubble in a running instance (same as the hotkey)
// --target takes an app name or bundle id; without it Buddy looks at the frontmost app.

let arguments = CommandLine.arguments

func argument(after flag: String) -> String? {
    guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

if let question = argument(after: "--send") {
    var info: [String: String] = ["q": question]
    if let target = argument(after: "--target") { info["app"] = target }
    DistributedNotificationCenter.default().postNotificationName(
        BuddyNotification.ask, object: nil, userInfo: info, deliverImmediately: true)
    exit(0)
}
if arguments.contains("--summon") {
    DistributedNotificationCenter.default().postNotificationName(
        BuddyNotification.summon, object: nil, userInfo: nil, deliverImmediately: true)
    exit(0)
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate(initialQuestion: argument(after: "--ask"), initialTarget: argument(after: "--target"))
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
