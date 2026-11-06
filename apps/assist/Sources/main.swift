import Cocoa

// Relay Buddy: a cursor helper that points at things on screen.
//
// CLI:
//   RelayBuddy                          run the menu-bar app
//   RelayBuddy --ask "q" [--target app] run the app and ask "q" once it is up
//   RelayBuddy --send "q" [--target app] ask a running instance, then exit
//   RelayBuddy --summon                 open the prompt bubble in a running instance (same as a hotkey tap)
//   RelayBuddy --undo                   press the Undo pill in a running instance
//   RelayBuddy --forget "q"             delete the cached plans for "q" (every app and context), then exit
//   RelayBuddy --voice-test|--voice-say|--voice-barge ...   voice self-tests (Sources/Voice/README.md)
//   RelayBuddy --present                driven overlay and voice: JSON commands on stdin, events on stdout (Sources/Presenter.swift)
// --target takes an app name or bundle id; without it Buddy looks at the frontmost app.

let arguments = CommandLine.arguments

func argument(after flag: String) -> String? {
    guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}
if let question = argument(after: "--forget") {
    let count = PlanCache.forget(question)
    print("forgot \(count) cached plan\(count == 1 ? "" : "s") for \"\(PlanCache.normalize(question))\"")
    exit(0)
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
if arguments.contains("--undo") {
    DistributedNotificationCenter.default().postNotificationName(
        BuddyNotification.undo, object: nil, userInfo: nil, deliverImmediately: true)
    exit(0)
}
if arguments.contains("--present") {
    MainActor.assumeIsolated {
        let app = NSApplication.shared
        let presenter = PresenterApp()
        PresenterApp.shared = presenter
        app.delegate = presenter
        app.setActivationPolicy(.accessory)
        app.run()
    }
}
if VoiceTest.handles(arguments) {
    let done = DispatchSemaphore(value: 0)
    nonisolated(unsafe) var code: Int32 = 0
    Task {
        code = await VoiceTest.run(arguments)
        done.signal()
    }
    while done.wait(timeout: .now()) == .timedOut { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    exit(code)
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate(initialQuestion: argument(after: "--ask"), initialTarget: argument(after: "--target"))
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
