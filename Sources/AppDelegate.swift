import Carbon.HIToolbox
import Cocoa

enum BuddyNotification {
    static let ask = Notification.Name("com.relay.buddy.ask")
    static let summon = Notification.Name("com.relay.buddy.summon")
    /// A new instance asks any older one to quit, so rebuild-and-run never leaves two Buddies.
    static let quit = Notification.Name("com.relay.buddy.quit")
}

enum Log {
    private static let url: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("RelayBuddy.log")
    }()
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()

    static func info(_ message: String) {
        let line = "\(formatter.string(from: Date())) \(message)\n"
        FileHandle.standardError.write(Data(line.utf8))
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
        } else {
            try? Data(line.utf8).write(to: url)
        }
    }
}

/// The app Buddy looks at: whatever was frontmost when the user summoned it.
struct TargetApp {
    let pid: pid_t
    let name: String
    let bundleID: String

    init(_ app: NSRunningApplication) {
        pid = app.processIdentifier
        name = app.localizedName ?? "this app"
        bundleID = app.bundleIdentifier ?? ""
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let initialQuestion: String?
    private let initialTarget: String?
    private var statusItem: NSStatusItem?
    private let hotKey = HotKey()
    private let overlay = OverlayController()
    private let brain = Brain()
    private var bubble: PromptBubble?
    private var target: TargetApp?
    private var lastExternalApp: NSRunningApplication?
    private var work: Task<Void, Never>?
    private var prefetch: Task<ScreenContext, Error>?

    init(initialQuestion: String?, initialTarget: String?) {
        self.initialQuestion = initialQuestion
        self.initialTarget = initialTarget
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        Log.info("Relay Buddy up. model=\(brain.model) capture=\(Capture.backendDescription)")
        lastExternalApp = NSWorkspace.shared.frontmostApplication.flatMap { isSelf($0) ? nil : $0 }
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            MainActor.assumeIsolated {
                guard let self, !self.isSelf(app) else { return }
                self.lastExternalApp = app
            }
        }

        setUpStatusItem()

        // Registered after the quit handoff below, so an older instance has released the combo.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.registerHotKey(attempt: 1) }

        let center = DistributedNotificationCenter.default()
        let me = String(ProcessInfo.processInfo.processIdentifier)
        center.postNotificationName(BuddyNotification.quit, object: me, userInfo: nil, deliverImmediately: true)
        center.addObserver(forName: BuddyNotification.quit, object: nil, queue: .main) { note in
            guard (note.object as? String) != me else { return }
            Log.info("a newer Relay Buddy started; quitting")
            MainActor.assumeIsolated { NSApp.terminate(nil) }
        }
        center.addObserver(forName: BuddyNotification.ask, object: nil, queue: .main) { [weak self] note in
            let question = note.userInfo?["q"] as? String ?? ""
            let app = note.userInfo?["app"] as? String
            MainActor.assumeIsolated { self?.askFromOutside(question, targetName: app) }
        }
        center.addObserver(forName: BuddyNotification.summon, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.summon() }
        }

        overlay.onDismiss = { [weak self] in
            self?.work?.cancel()
            self?.work = nil
        }

        if let question = initialQuestion {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                self?.askFromOutside(question, targetName: self?.initialTarget)
            }
        }
    }

    private func registerHotKey(attempt: Int) {
        let ok = hotKey.register(keyCode: UInt32(kVK_Space), modifiers: UInt32(controlKey | optionKey)) { [weak self] in
            self?.summon()
        }
        if ok { return Log.info("hotkey Control+Option+Space registered") }
        guard attempt < 5 else { return Log.info("hotkey registration FAILED (Control+Option+Space taken by another app?)") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.registerHotKey(attempt: attempt + 1) }
    }

    private func isSelf(_ app: NSRunningApplication) -> Bool {
        app.processIdentifier == ProcessInfo.processInfo.processIdentifier
    }

    private func currentExternalApp() -> TargetApp? {
        if let front = NSWorkspace.shared.frontmostApplication, !isSelf(front) { return TargetApp(front) }
        return lastExternalApp.map(TargetApp.init)
    }

    /// A running app by bundle id or name, for scripted asks.
    private func runningApp(named name: String) -> TargetApp? {
        NSWorkspace.shared.runningApplications.first {
            $0.bundleIdentifier == name || $0.localizedName?.caseInsensitiveCompare(name) == .orderedSame
        }.map(TargetApp.init)
    }

    private func setUpStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let image = NSImage(systemSymbolName: "cursorarrow.rays", accessibilityDescription: "Relay Buddy")
        image?.isTemplate = true
        item.button?.image = image
        let menu = NSMenu()
        let ask = NSMenuItem(title: "Ask Buddy", action: #selector(menuSummon), keyEquivalent: " ")
        ask.keyEquivalentModifierMask = [.control, .option]
        ask.target = self
        menu.addItem(ask)
        menu.addItem(.separator())
        let model = NSMenuItem(title: "Model: \(brain.model)", action: nil, keyEquivalent: "")
        model.isEnabled = false
        menu.addItem(model)
        let capture = NSMenuItem(title: "Capture: \(Capture.backendDescription)", action: nil, keyEquivalent: "")
        capture.isEnabled = false
        menu.addItem(capture)
        if !CGPreflightScreenCaptureAccess() || !AXIsProcessTrusted() {
            let setup = NSMenuItem(title: "Give Buddy Its Own Permissions…", action: #selector(requestPermissions), keyEquivalent: "")
            setup.target = self
            menu.addItem(setup)
        }
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Relay Buddy", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
        item.menu = menu
        statusItem = item
    }

    @objc private func menuSummon() {
        // The menu closes first; give the previously frontmost app a beat to be front again.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in self?.summon() }
    }

    /// Only on an explicit menu click: asks macOS for Screen Recording and Accessibility.
    /// Until granted, Buddy borrows cua-driver's grants when its daemon is running.
    @objc private func requestPermissions() {
        if !CGPreflightScreenCaptureAccess() { CGRequestScreenCaptureAccess() }
        if !AXIsProcessTrusted() {
            AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        }
    }

    /// Hotkey: open the prompt bubble at the cursor. Pressing it again closes the bubble.
    func summon() {
        if let open = bubble {
            open.close()
            bubble = nil
            return
        }
        overlay.dismiss(fast: true)
        target = currentExternalApp()
        let appName = target?.name ?? "this app"
        Log.info("summon: target=\(appName)")
        // Look at the window while the user types: it is what they are asking about, and it
        // takes the capture off the wait after they press Return.
        prefetch = target.map { app in Task { try await Capture.capture(app) } }
        let newBubble = PromptBubble(appName: appName)
        newBubble.onSubmit = { [weak self] text in self?.submit(text) }
        newBubble.onClose = { [weak self] in self?.bubble = nil }
        newBubble.show(near: NSEvent.mouseLocation)
        bubble = newBubble
    }

    private func submit(_ question: String) {
        bubble?.close()
        bubble = nil
        guard let target = target ?? currentExternalApp() else {
            overlay.showMessage("I can't see an app in front to look at.", near: NSEvent.mouseLocation)
            return
        }
        ask(question, about: target, prefetched: prefetch)
        prefetch = nil
    }

    private func askFromOutside(_ question: String, targetName: String?) {
        let trimmed = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return summon() }
        let resolved = targetName.flatMap(runningApp(named:)) ?? currentExternalApp()
        guard let target = resolved else {
            overlay.showMessage("I can't see an app in front to look at.", near: NSEvent.mouseLocation)
            return
        }
        ask(trimmed, about: target)
    }

    private func ask(_ question: String, about target: TargetApp, prefetched: Task<ScreenContext, Error>? = nil) {
        work?.cancel()
        let stay = question.range(of: #"\bstay\b"#, options: [.regularExpression, .caseInsensitive]) != nil
        Log.info("ask: \"\(question)\" target=\(target.name) pid=\(target.pid) stay=\(stay)")
        let started = Date()
        overlay.showThinking(near: NSEvent.mouseLocation, appName: target.name)
        work = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let context: ScreenContext
                if let prefetched, let early = try? await prefetched.value {
                    context = early
                } else {
                    context = try await Capture.capture(target)
                }
                Log.info(String(format: "captured %@ window %.0fx%.0f via %@ in %.2fs, %d AX lines",
                                target.name, context.windowFrame.width, context.windowFrame.height,
                                context.backend, Date().timeIntervalSince(started), context.axLines.count))
                try Task.checkCancellation()
                let plan = try await self.brain.plan(question: question, context: context)
                try Task.checkCancellation()
                Log.info(String(format: "plan in %.2fs total: %@", Date().timeIntervalSince(started), plan.summary))
                self.overlay.perform(plan, context: context, stay: stay)
            } catch is CancellationError {
                Log.info("ask cancelled")
            } catch {
                Log.info("ask failed: \(error.localizedDescription)")
                self.overlay.showMessage(error.localizedDescription, near: nil)
            }
        }
    }
}
