import ApplicationServices
import Carbon.HIToolbox
import Cocoa

enum BuddyNotification {
    static let ask = Notification.Name("com.relay.buddy.ask")
    static let summon = Notification.Name("com.relay.buddy.summon")
    static let undo = Notification.Name("com.relay.buddy.undo")
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
struct TargetApp: Sendable {
    let pid: pid_t
    let name: String
    let bundleID: String

    init(_ app: NSRunningApplication) {
        pid = app.processIdentifier
        name = app.localizedName ?? "this app"
        bundleID = app.bundleIdentifier ?? ""
    }

    /// System surfaces that are frontmost without being an app the user is learning.
    static let ignoredBundleIDs: Set<String> = [
        "com.apple.loginwindow", "com.apple.ScreenSaver.Engine", "com.apple.dock",
        "com.apple.notificationcenterui", "com.apple.controlcenter", "com.apple.Spotlight",
    ]
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let initialQuestion: String?
    private let initialTarget: String?
    private var statusItem: NSStatusItem?
    private let hotKey = HoldHotKey()
    private let overlay = OverlayController()
    private let brain = Brain()
    private let voice = VoiceController()
    private lazy var lesson = LessonController(brain: brain, overlay: overlay)
    private var bubble: PromptBubble?
    private var target: TargetApp?
    private var lastExternalApp: NSRunningApplication?
    private var work: Task<Void, Never>?
    private var prefetch: Task<ScreenContext, Error>?
    /// RELAY_BUDDY_SPEAK=0 keeps Buddy quiet (tests, recordings).
    private let speaks = ProcessInfo.processInfo.environment["RELAY_BUDDY_SPEAK"] != "0"

    init(initialQuestion: String?, initialTarget: String?) {
        self.initialQuestion = initialQuestion
        self.initialTarget = initialTarget
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        Log.info("Relay Buddy up. model=\(brain.model) capture=\(Capture.backendDescription)")
        lastExternalApp = NSWorkspace.shared.frontmostApplication.flatMap { isIgnorable($0) ? nil : $0 }
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            MainActor.assumeIsolated {
                guard let self, !self.isIgnorable(app) else { return }
                self.lastExternalApp = app
            }
        }

        setUpStatusItem()
        setUpVoice()
        lesson.speak = { [weak self] text in self?.say(text) }

        let center = DistributedNotificationCenter.default()
        let me = String(ProcessInfo.processInfo.processIdentifier)
        center.postNotificationName(BuddyNotification.quit, object: me, userInfo: nil, deliverImmediately: true)
        center.addObserver(forName: BuddyNotification.quit, object: nil, queue: .main) { note in
            guard (note.object as? String) != me else { return }
            Log.info("a newer Relay Buddy started; quitting")
            MainActor.assumeIsolated { NSApp.terminate(nil) }
        }
        // Registered after the quit handoff, so an older instance has released the combo.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.registerHotKey(attempt: 1) }

        center.addObserver(forName: BuddyNotification.ask, object: nil, queue: .main) { [weak self] note in
            let question = note.userInfo?["q"] as? String ?? ""
            let app = note.userInfo?["app"] as? String
            MainActor.assumeIsolated { self?.askFromOutside(question, targetName: app) }
        }
        center.addObserver(forName: BuddyNotification.summon, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.summon() }
        }
        center.addObserver(forName: BuddyNotification.undo, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.overlay.undoNow() }
        }

        overlay.onDismiss = { [weak self] in
            self?.voice.stopSpeaking()
        }

        if let question = initialQuestion {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                self?.askFromOutside(question, targetName: self?.initialTarget)
            }
        }
    }

    // MARK: Hotkey and voice

    /// Tap Control+Option+Space: typed bubble. Hold it: talk.
    private func registerHotKey(attempt: Int) {
        hotKey.onTap = { [weak self] in self?.summon() }
        hotKey.onHoldStart = { [weak self] in self?.startTalking() }
        hotKey.onHoldEnd = { [weak self] in self?.voice.endListening() }
        if hotKey.register(keyCode: UInt32(kVK_Space), modifiers: UInt32(controlKey | optionKey)) {
            return Log.info("hotkey Control+Option+Space registered (tap: type, hold: talk)")
        }
        guard attempt < 5 else { return Log.info("hotkey registration FAILED (Control+Option+Space taken by another app?)") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.registerHotKey(attempt: attempt + 1) }
    }

    private func setUpVoice() {
        voice.onListening = { [weak self] on in self?.bubble?.setListening(on) }
        voice.onPartial = { [weak self] text in self?.bubble?.showTranscript(text) }
        voice.onFinal = { [weak self] text in
            Log.info("voice: \"\(text)\"")
            self?.submit(text)
        }
        voice.onNoSpeech = { [weak self] in
            self?.bubble?.setListening(false)
            self?.overlay.showMessage("I didn't catch that. Hold the keys and try again.", near: NSEvent.mouseLocation)
        }
        voice.onError = { [weak self] error in
            Log.info("voice error: \(error.localizedDescription)")
            self?.overlay.showMessage(error.localizedDescription, near: NSEvent.mouseLocation)
        }
    }

    private func startTalking() {
        if bubble == nil { summon() }
        voice.beginListening()
    }

    private func say(_ text: String?) {
        guard speaks, let text, !text.isEmpty else { return }
        voice.speak(text)
    }

    // MARK: Targets

    private func isIgnorable(_ app: NSRunningApplication) -> Bool {
        app.processIdentifier == ProcessInfo.processInfo.processIdentifier
            || TargetApp.ignoredBundleIDs.contains(app.bundleIdentifier ?? "")
            || app.activationPolicy == .prohibited
    }

    /// The app the user is looking at: the frontmost real app, else the last one that was, else
    /// the owner of the frontmost normal window (the Mac may be locked or on a system surface).
    private func currentExternalApp() -> TargetApp? {
        if let front = NSWorkspace.shared.frontmostApplication, !isIgnorable(front) { return TargetApp(front) }
        if let last = lastExternalApp, !last.isTerminated { return TargetApp(last) }
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] else { return nil }
        for entry in list where (entry[kCGWindowLayer as String] as? Int) == 0 {
            guard let pid = entry[kCGWindowOwnerPID as String] as? Int,
                  let app = NSRunningApplication(processIdentifier: pid_t(pid)), !isIgnorable(app),
                  app.activationPolicy == .regular else { continue }
            return TargetApp(app)
        }
        return nil
    }

    /// A running app by bundle id or name, for scripted asks.
    private func runningApp(named name: String) -> TargetApp? {
        NSWorkspace.shared.runningApplications.first {
            $0.bundleIdentifier == name || $0.localizedName?.caseInsensitiveCompare(name) == .orderedSame
        }.map(TargetApp.init)
    }

    // MARK: Menu

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
        menu.addItem(NSMenuItem(title: "Quit Relay Buddy", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
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

    // MARK: Asking

    /// Hotkey tap: open the prompt bubble at the cursor. Pressing it again closes the bubble.
    func summon() {
        voice.stopSpeaking()
        if let open = bubble {
            voice.cancelListening()
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
        newBubble.onClose = { [weak self] in
            self?.bubble = nil
            self?.voice.cancelListening()
        }
        if lesson.isActive { newBubble.setLessonHint("next, skip or stop the lesson") }
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
        route(question, target: target, prefetched: prefetch)
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
        route(trimmed, target: target, prefetched: nil)
    }

    /// Lesson words, "teach me to ...", or a plain question.
    private func route(_ question: String, target: TargetApp, prefetched: Task<ScreenContext, Error>?) {
        if lesson.handleCommand(question) { return }
        if let goal = LessonController.goal(in: question) {
            work?.cancel()
            return lesson.start(goal: goal, target: target)
        }
        lesson.stop()
        ask(question, about: target, prefetched: prefetched)
    }

    private func ask(_ question: String, about target: TargetApp, prefetched: Task<ScreenContext, Error>? = nil) {
        work?.cancel()
        voice.stopSpeaking()
        let stay = question.range(of: #"\bstay\b"#, options: [.regularExpression, .caseInsensitive]) != nil
        let hook = AppHooks.hook(for: target)
        let askedToDo = DoPermission.userAskedToDo(question)
        Log.info("ask: \"\(question)\" target=\(target.name) pid=\(target.pid) stay=\(stay) doIt=\(askedToDo) hook=\(hook?.name ?? "none")")
        let started = Date()
        overlay.showThinking(near: NSEvent.mouseLocation, appName: target.name)
        work = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                async let state = hook?.sceneState()
                let context: ScreenContext
                if let prefetched, let early = try? await prefetched.value {
                    context = early
                } else {
                    context = try await Capture.capture(target)
                }
                let ask = AskContext(sceneState: await state, hookName: hook?.name, hookNotes: hook?.promptNotes,
                                     userAskedToDo: askedToDo)
                Log.info(String(format: "captured %@ window %.0fx%.0f via %@ in %.2fs, %d AX lines, hook state %@",
                                target.name, context.windowFrame.width, context.windowFrame.height, context.backend,
                                Date().timeIntervalSince(started), context.axLines.count,
                                ask.sceneState.map { "\($0.split(separator: "\n").count) lines" } ?? "none"))
                try Task.checkCancellation()
                let plan = try await self.brain.plan(question: question, context: context, ask: ask)
                try Task.checkCancellation()
                Log.info(String(format: "plan in %.2fs total: %@", Date().timeIntervalSince(started), plan.summary))
                try await self.carryOut(plan, question: question, context: context, ask: ask, hook: hook, stay: stay)
            } catch is CancellationError {
                Log.info("ask cancelled")
            } catch {
                Log.info("ask failed: \(error.localizedDescription)")
                self.overlay.showMessage(error.localizedDescription, near: nil)
            }
        }
    }

    /// Points, or does chores (then looks again and points), or does the step when asked to.
    private func carryOut(_ plan: Plan, question: String, context: ScreenContext, ask: AskContext,
                          hook: AppHook?, stay: Bool) async throws {
        guard var request = plan.doRequest else {
            overlay.perform(plan, context: context, stay: stay)
            return say(plan.say)
        }
        if request.coreStep && !ask.userAskedToDo {
            // The model wanted to do the very thing being taught: drop the actions, teach instead.
            Log.info("refused core step without permission: \(request.announce)")
            var teaching = plan
            teaching.doRequest = nil
            if teaching.say == nil { teaching.say = request.announce }
            overlay.perform(teaching, context: context, stay: stay)
            return say(teaching.say)
        }
        request = DoRequest(announce: request.announce, coreStep: request.coreStep, actions: Array(request.actions.prefix(6)))
        let point = request.actions.compactMap(\.point).first
        await overlay.chore(at: point, context: context, caption: request.coreStep ? "On it..." : (plan.say ?? "One sec..."))
        try Task.checkCancellation()
        let undo: UndoRecord
        do {
            undo = try await Executor.run(request, context: context, hook: hook)
        } catch {
            Log.info("do failed: \(error.localizedDescription)")
            overlay.showMessage("I couldn't do that: \(error.localizedDescription)", near: nil)
            return
        }
        Log.info("did: \(request.announce) (core=\(request.coreStep))")
        overlay.setCaption(request.announce)
        overlay.showUndo(undo)
        say(request.announce)

        if request.coreStep {
            overlay.perform(Plan(say: request.announce), context: context, stay: stay)
            return
        }
        // A chore cleared the way: look again and point at what the user asked about.
        try await Task.sleep(nanoseconds: 300_000_000)
        async let state = hook?.sceneState()
        let fresh = try await Capture.capture(context.target)
        var next = ask
        next.sceneState = await state
        next.note = "Buddy just did a chore for the user: \(request.announce). Do not call do() again. " +
            "Now point at what the user asked about, on this fresh screenshot."
        var plan2 = try await brain.plan(question: question, context: fresh, ask: next)
        try Task.checkCancellation()
        plan2.doRequest = nil
        Log.info("plan after chore: \(plan2.summary)")
        overlay.perform(plan2, context: fresh, stay: stay)
        say(plan2.say)
    }
}
