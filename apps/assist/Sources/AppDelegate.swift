import ApplicationServices
import Carbon.HIToolbox
import AVFoundation
import Cocoa

enum BuddyNotification {
    static let ask = Notification.Name("com.relay.buddy.ask")
    static let summon = Notification.Name("com.relay.buddy.summon")
    static let undo = Notification.Name("com.relay.buddy.undo")
    /// A new instance asks any older one to quit, so rebuild-and-run never leaves two Buddies.
    static let quit = Notification.Name("com.relay.buddy.quit")
}

enum Log {
    /// RELAY_BUDDY_LOG moves it (the test runner logs to a temp file).
    private static let url: URL = {
        if let path = ProcessInfo.processInfo.environment["RELAY_BUDDY_LOG"] { return URL(fileURLWithPath: path) }
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

    init(pid: pid_t, name: String, bundleID: String) {
        self.pid = pid
        self.name = name
        self.bundleID = bundleID
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
    /// RELAY_BUDDY_SPEAK=0 keeps the assistant quiet (tests, recordings).
    private let speaks = ProcessInfo.processInfo.environment["RELAY_BUDDY_SPEAK"] != "0"
    /// Who answers the current ask (AssistantRouter): her name, colours, avatar and voice.
    private var assistant = Assistants.personal

    init(initialQuestion: String?, initialTarget: String?) {
        self.initialQuestion = initialQuestion
        self.initialTarget = initialTarget
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        Log.info("Relay Assist up. model=\(brain.model) capture=\(Capture.backendDescription) assistants=\(Assistants.all.map { "\($0.title)(\($0.liveVoice))" }.joined(separator: ","))")
        // The grants as macOS answers for this process (Relay's when Relay started it).
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        let mic = status == .authorized ? "authorized" : status == .denied ? "denied" : status == .notDetermined ? "notDetermined" : "restricted"
        Log.info("permissions: screenRecording=\(CGPreflightScreenCaptureAccess()) accessibility=\(AXIsProcessTrusted()) microphone=\(mic) parent=\(getppid())")
        Assistants.prepareAvatars()
        EcardRepos.refreshIfStale()
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
            Log.info("a newer Relay Assist started; quitting")
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
        overlay.onUndo = { [weak self] in self?.trust.undone() }
        trust.undoShowing = { [weak self] in self?.overlay.undoAvailable == true }
        overlay.isSpeaking = { [weak self] in self?.voice.isSpeaking ?? false }
        overlay.onEscape = { [weak self] in _ = self?.lesson.handleCommand("stop") }
        Log.info(AXIsProcessTrusted()
                 ? "esc: Accessibility granted, passive global key monitor (Esc also reaches the app)"
                 : "esc: no Accessibility, so global key monitors get no keys; Carbon Esc hotkey while the overlay shows, Stop button for lessons")

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

    /// The last caption she spoke or showed, for handoffs ("the last thing I explained").
    private var lastSaid: String?

    private func say(_ text: String?) {
        guard let text, !text.isEmpty else { return }
        lastSaid = text
        guard speaks else { return }
        voice.speak(text, voice: assistant.liveVoice)
    }

    /// Makes `next` the one answering: cursor, bubble colours, captions' tag, voice and the brain's persona.
    private func answer(as next: Assistant) {
        assistant = next
        brain.assistantName = next.title
        overlay.setAssistant(next)
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
        let image = NSImage(systemSymbolName: "cursorarrow.rays", accessibilityDescription: "Relay Assist")
        image?.isTemplate = true
        item.button?.image = image
        item.button?.toolTip = "Relay Assist: \(Assistants.all.map(\.title).joined(separator: " and "))"
        let menu = NSMenu()
        let ask = NSMenuItem(title: "Ask \(Assistants.personal.title) or \(Assistants.work.title)", action: #selector(menuSummon), keyEquivalent: " ")
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
            // Started by Relay, macOS asks under Relay's name: the grants belong to Relay.
            let setup = NSMenuItem(title: "Allow Screen Recording and Accessibility…", action: #selector(requestPermissions), keyEquivalent: "")
            setup.target = self
            menu.addItem(setup)
        }
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Relay Assist", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
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
        // Who answers by what is on screen; the question can still change it on submit.
        let likely = AssistantRouter.route("", target: target, stage: "summon")
        answer(as: likely.assistant)
        Log.info("summon: target=\(appName) assistant=\(likely.assistant.title)")
        // Look at the window while the user types: it is what they are asking about, and it
        // takes the capture off the wait after they press Return.
        prefetch = target.map { app in Task { try await Capture.capture(app) } }
        let newBubble = PromptBubble(assistant: likely.assistant)
        newBubble.router = { AssistantRouter.live($0, screen: likely) }
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

    /// Picks who answers, then: a no-brain shortcut, lesson words, "teach me to ...", or a plain question.
    private func route(_ asked: String, target: TargetApp, prefetched: Task<ScreenContext, Error>?) {
        let started = Date()
        let decision = AssistantRouter.route(asked, target: target, stage: "ask")
        answer(as: decision.assistant)
        let question = decision.question
        if Capabilities.isAsking(question) {
            return showCapabilities(target: target, started: started)
        }
        if let shortcut = Shortcut.match(question, target: target) {
            lesson.stop()
            return runShortcut(shortcut, started: started)
        }
        if let intent = Handoff.intent(in: question) {
            lesson.stop()
            return runHandoff(intent, said: question, target: target, assistant: decision.assistant, started: started)
        }
        if lesson.handleCommand(question) { return }
        if let goal = LessonController.goal(in: question) ?? learningHowTo(question, target: target) {
            work?.cancel()
            return lesson.start(goal: goal, target: target, assistant: decision.assistant)
        }
        lesson.stop()
        ask(question, about: target, prefetched: prefetched)
    }

    /// "how do I bevel this cube" in an app you're learning (one with a live hook, like Blender) gets a
    /// step-by-step lesson that waits for each step, not a one-line answer mixing shortcuts and tools.
    private func learningHowTo(_ question: String, target: TargetApp) -> String? {
        guard AppHooks.hook(for: target) is BlenderHook else { return nil }
        let pattern = #"^\s*(?:so\s+|ok\s+|okay\s+)?(?:how (?:do|can|would|should) i|how to|how do you)\s+(.+?)\??\s*$"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = regex.firstMatch(in: question, range: NSRange(question.startIndex..., in: question)),
              let range = Range(match.range(at: 1), in: question) else { return nil }
        return String(question[range])
    }

    /// "What can you do here?" / "help": the template from Capabilities, spoken plus one caption line. A
    /// running lesson keeps going.
    private func showCapabilities(target: TargetApp, started: Date) {
        work?.cancel()
        voice.stopSpeaking()
        let hook = AppHooks.hook(for: target)
        let navigates = Navigator.enabled && hook == nil && !Navigator.skips(target) && Jev.isAvailable
        let answer = Capabilities.answer(app: target.name, bundleID: target.bundleID, hook: hook?.name, navigates: navigates,
                                         inLesson: lesson.isActive, workAssistant: Assistants.work.title)
        overlay.showMessage(answer.caption, near: NSEvent.mouseLocation)
        say(answer.spoken)
        Log.info(String(format: "route: path=capabilities app=%@ hook=%@ nav=%@ lesson=%@ total=%.0fms said=\"%@\"", target.name,
                        hook?.name ?? "none", navigates ? "yes" : "no", lesson.isActive ? "yes" : "no",
                        Date().timeIntervalSince(started) * 1000, answer.spoken))
    }

    /// Opens what the question names without asking the brain: a Linear issue (then points at its
    /// title) or a GitHub pull request in the default browser.
    private func runShortcut(_ shortcut: Shortcut, started: Date) {
        work?.cancel()
        voice.stopSpeaking()
        let ms = { String(format: "%.0f", Date().timeIntervalSince(started) * 1000) }
        work = Task { @MainActor [weak self] in
            guard let self else { return }
            switch shortcut {
            case .linear(let key):
                let via = Shortcut.openLinear(key)
                Log.info("route: path=shortcut kind=linear key=\(key) via=\(via) opened=\(ms())ms")
                self.overlay.showMessage("Opening \(key) in Linear", near: NSEvent.mouseLocation)
                guard let linear = await Shortcut.waitForLinear(showing: key, timeout: 8) else {
                    Log.info("shortcut: Linear never showed \(key) within 8s (total=\(ms())ms)")
                    return
                }
                Log.info("shortcut: Linear shows \(key) at \(ms())ms")
                let title = await Shortcut.issueTitle(key, pid: linear.pid)
                var spot: (AXElement, ScreenContext)?
                if let title {
                    for _ in 0..<5 where spot == nil {
                        if Task.isCancelled { return }
                        if let context = try? await Capture.capture(linear), let element = Shortcut.titleElement(title, in: context) {
                            spot = (element, context)
                        } else {
                            try? await Task.sleep(nanoseconds: 250_000_000)
                        }
                    }
                }
                let full = title.map { "Here's \(key): \($0)" } ?? "Here's \(key)"
                let caption = full.count <= 90 ? full : String(full.prefix(87)) + "..."
                if let (element, context) = spot {
                    var plan = Plan()
                    plan.steps = [PlanStep(kind: .point(element.center), label: element.label)]
                    plan.say = caption
                    self.overlay.perform(plan, context: context, stay: false)
                } else {
                    self.overlay.showMessage(caption, near: nil)
                }
                self.say(caption)
                Log.info("route: path=shortcut kind=linear key=\(key) point=\(spot == nil ? "none" : "title") total=\(ms())ms")
            case .pullRequest(let url):
                NSWorkspace.shared.open(url)
                self.overlay.showMessage("Opening that pull request in your browser", near: NSEvent.mouseLocation)
                Log.info("route: path=shortcut kind=github url=\(url.absoluteString) total=\(ms())ms")
            case .pullRequestNumber(let number, let repo):
                self.overlay.showThinking(near: NSEvent.mouseLocation, appName: "\(repo) PR \(number)")
                guard let url = await Shortcut.resolve(number, repo: repo) else {
                    Log.info("route: path=shortcut kind=github pr=\(number) repo=\(repo) not found total=\(ms())ms")
                    return self.overlay.showMessage("I couldn't find PR \(number) in \(repo)", near: nil)
                }
                NSWorkspace.shared.open(url)
                self.overlay.showMessage("Opening \(repo) PR \(number) in your browser", near: nil)
                Log.info("route: path=shortcut kind=github pr=\(number) repo=\(repo) url=\(url.absoluteString) total=\(ms())ms")
            }
        }
    }

    /// Bundles the screen and hands it on (Handoff): a message in the assistant's Relay thread (tickets go to
    /// Astra as a draft request), or a follow-up in Nova's followups.json. One line confirms it.
    private func runHandoff(_ intent: Handoff.Intent, said: String, target: TargetApp, assistant: Assistant, started: Date) {
        work?.cancel()
        voice.stopSpeaking()
        let agent = intent.kind == .ticket ? Assistants.work : (intent.kind == .remind ? Assistants.personal : assistant)
        answer(as: agent)
        overlay.showMessage(intent.kind == .remind ? "Saving that..." : "Handing this to \(agent.title)...", near: NSEvent.mouseLocation)
        let explained = lastSaid
        work = Task { @MainActor [weak self] in
            guard let self else { return }
            let bundle = await Handoff.gather(target: target, lastExplanation: explained)
            let line: String
            var detail = ""
            if intent.kind == .remind, let when = intent.when {
                var text = (intent.test ? "TEST (Relay Assist handoff test, just mark done): " : "") +
                    "Remind Isaac about what he was looking at in \(bundle.app): \"\(bundle.windowTitle)\"."
                if let t = bundle.ticket { text += " Ticket \(t)." }
                if let u = bundle.url { text += " \(u)" }
                if let s = bundle.selection { text += " He had selected: \"\(s.prefix(300))\"." }
                if let p = bundle.screenshot { text += " Screenshot: \(p)" }
                let ok = Handoff.remind(agent: Assistants.personal.id, at: when, text: text)
                line = ok ? "I'll remind you \(Handoff.describe(when))" : "I couldn't save that reminder"
                detail = "at=\(ISO8601DateFormatter().string(from: when))"
            } else {
                let (ok, out) = await Handoff.tell(agent: agent.id, Handoff.message(intent, said: said, bundle: bundle))
                line = ok ? "Sent to \(agent.title)" : "I couldn't reach \(agent.title) (\(out))"
                detail = out
            }
            Log.info(String(format: "route: path=handoff kind=%@ agent=%@ test=%@ ticket=%@ selection=%@ shot=%@ %@ total=%.0fms",
                            intent.kind.rawValue, agent.id, intent.test ? "yes" : "no", bundle.ticket ?? "-",
                            bundle.selection == nil ? "no" : "yes", bundle.screenshot == nil ? "no" : "yes", detail,
                            Date().timeIntervalSince(started) * 1000))
            self.overlay.showMessage(line, near: nil)
            self.say(line)
        }
    }

    private func ask(_ question: String, about target: TargetApp, prefetched: Task<ScreenContext, Error>? = nil) {
        work?.cancel()
        trust.newAsk()
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
                async let layoutRaw = (hook as? BlenderHook)?.layout()
                var context: ScreenContext
                if let prefetched, let early = try? await prefetched.value {
                    context = early
                } else {
                    context = try await Capture.capture(target)
                }
                var ask = AskContext(sceneState: await state, hookName: hook?.name, hookNotes: hook?.promptNotes,
                                     userAskedToDo: askedToDo)
                let blender = BlenderLayout(await layoutRaw, context: context)
                if let blender { ask.sceneState = (ask.sceneState.map { $0 + "\n" } ?? "") + blender.prompt }
                Log.info(String(format: "captured %@ window %.0fx%.0f via %@ in %.2fs, %d AX lines, hook state %@",
                                target.name, context.windowFrame.width, context.windowFrame.height, context.backend,
                                Date().timeIntervalSince(started), context.axLines.count,
                                ask.sceneState.map { "\($0.split(separator: "\n").count) lines" } ?? "none"))
                try Task.checkCancellation()
                if Navigator.enabled, hook == nil, !Navigator.skips(target), Navigator.isNavigation(question),
                   Jev.isAvailable, Jev.hasUsableTree(context.axLines) {
                    switch await self.navigate(question, context: context, started: started, stay: stay) {
                    case .handled: return
                    case .fallback(let moved):
                        // Presses already changed the screen: Terra must plan from what is there now.
                        if moved { context = try await Capture.capture(target) }
                    }
                } else if hook == nil, Navigator.isNavigation(question) {
                    Log.info("route: jev-nav skipped (nav=\(Navigator.enabled) skipApp=\(Navigator.skips(target)) jev=\(Jev.isAvailable) AX=\(context.axLines.count) lines), terra")
                }
                // Trailblaze: replay what Terra worked out last time for this ask in this context.
                let cacheOn = PlanCache.enabled && hook?.name != "Linear" && !askedToDo
                let fingerprint = PlanCache.fingerprint(context: context, sceneState: ask.sceneState, hook: hook)
                let cacheKey = PlanCache.key(context: context, question: question, fingerprint: fingerprint)
                var prefix: [CachedPhase] = []
                let lookupStarted = Date()
                var cacheMissed = false
                if cacheOn {
                    if let entry = PlanCache.lookup(cacheKey) {
                        // Until the next ask, Undo means this replay was wrong (PlanTrust deletes the entry).
                        self.trust.replayed(cacheKey)
                        switch try await self.replay(entry, context: context, hook: hook, stay: stay, started: started) {
                        case .done:
                            PlanCache.recordHit(cacheKey)
                            Log.info(String(format: "plan-cache: hit %.0fms (terra calls: 0)", Date().timeIntervalSince(started) * 1000))
                            return
                        case .failed(let ran, let moved):
                            Log.info(String(format: "plan-cache: stale %.0fms, falling back to terra (%d chore phases already ran)",
                                            Date().timeIntervalSince(lookupStarted) * 1000, ran.count))
                            prefix = ran
                            if moved {
                                try await Task.sleep(nanoseconds: 300_000_000)
                                context = try await Capture.capture(target)
                                ask.sceneState = await hook?.sceneState()
                            }
                        }
                    } else {
                        cacheMissed = true
                    }
                }
                if Navigator.enabled, !askedToDo, let (jevPlan, pick) = await self.tryJev(question, context: context) {
                    Log.info(String(format: "route: path=jev jev=%dms total=%.0fms point=\"%@\" conf=%@", pick.ms,
                                    Date().timeIntervalSince(started) * 1000, pick.element.label,
                                    pick.confidence.map { String(format: "%.2f", $0) } ?? "n/a"))
                    self.overlay.perform(jevPlan, context: context, stay: stay)
                    self.say(jevPlan.say)
                    let askedAt = Date()
                    if let richer = await self.brain.caption(question: question, app: target.name, label: pick.element.label,
                                                             role: pick.element.role, timeout: 2.5) {
                        try Task.checkCancellation()
                        self.overlay.setCaption(richer)
                        Log.info(String(format: "caption: terra text %.0fms replaced template with \"%@\"", Date().timeIntervalSince(askedAt) * 1000, richer))
                    } else {
                        Log.info(String(format: "caption: terra text gave nothing within 2.5s (%.0fms), template kept", Date().timeIntervalSince(askedAt) * 1000))
                    }
                    return
                }
                if cacheMissed {
                    Log.info(String(format: "plan-cache: miss %.0fms (%@)", Date().timeIntervalSince(lookupStarted) * 1000, fingerprint))
                }
                let terraStarted = Date()
                var plan = try await self.brain.plan(question: question, context: context, ask: ask)
                if let blender { plan.steps = blender.refine(plan.steps) }
                try Task.checkCancellation()
                Log.info(String(format: "route: path=terra terra=%.0fms total=%.0fms", Date().timeIntervalSince(terraStarted) * 1000,
                                Date().timeIntervalSince(started) * 1000))
                Log.info(String(format: "plan in %.2fs total: %@", Date().timeIntervalSince(started), plan.summary))
                let recorded = try await self.carryOut(plan, question: question, context: context, ask: ask, hook: hook, stay: stay,
                                                       started: started)
                if cacheOn, let recorded, !recorded.isEmpty {
                    self.trust.schedule(cacheKey, CachedPlan(question: PlanCache.normalize(question), bundleID: target.bundleID,
                                                             version: PlanCache.version(of: target), fingerprint: fingerprint,
                                                             phases: prefix + recorded, savedAt: Date(), hits: 0))
                }
            } catch is CancellationError {
                Log.info("ask cancelled")
            } catch {
                Log.info("ask failed: \(error.localizedDescription)")
                self.overlay.showMessage(error.localizedDescription, near: nil)
            }
        }
    }

    /// Jev-first pointing: when the question names one control and the AX tree has a labelled
    /// match, Jev picks it and Buddy points at once. nil means "use Terra", with the reason logged.
    private func tryJev(_ question: String, context: ScreenContext) async -> (Plan, JevPick)? {
        guard Jev.isAvailable else { Log.info("route: jev off (no key), terra"); return nil }
        guard let named = Jev.namedTarget(in: question) else {
            Log.info("route: no single named target (how-to, vague or not a find), terra")
            return nil
        }
        guard Jev.hasUsableTree(context.axLines) else {
            Log.info("route: thin AX tree (\(context.axLines.count) lines), terra")
            return nil
        }
        guard let pick = await Jev.pick(question: question, app: context.target.name, title: context.windowTitle,
                                        elements: Jev.candidates(context.axLines)) else {
            Log.info("route: jev gave no pick for \"\(named)\", terra")
            return nil
        }
        if let c = pick.confidence, c < Jev.minConfidence {
            Log.info(String(format: "route: jev conf %.2f below %.2f for \"%@\" in %dms, terra", c, Jev.minConfidence, pick.element.label, pick.ms))
            return nil
        }
        guard Jev.labelMatches(pick.element.label, target: named) else {
            Log.info("route: jev picked \"\(pick.element.label)\" which does not match \"\(named)\" (\(pick.ms)ms), terra")
            return nil
        }
        var plan = Plan()
        plan.steps = [PlanStep(kind: .point(pick.element.center), label: pick.element.label)]
        plan.say = "\(pick.element.label) is here"
        plan.calls = ["jev:\(pick.element.line)"]
        return (plan, pick)
    }

    private enum NavOutcome {
        case handled
        /// `moved`: at least one control was pressed before giving up.
        case fallback(moved: Bool)
    }

    /// Jev navigation loop: press through the screens, gliding to each press, then point at the
    /// destination. Nothing is pressed that could flip a switch or delete (see jev-nav.ts).
    private func navigate(_ question: String, context: ScreenContext, started: Date, stay: Bool) async -> NavOutcome {
        let global = Navigator.globalContext(for: context.target, windowID: context.windowID)
        var glide: Task<Void, Never>?
        let result = await Navigator.run(goal: question, target: context.target, windowID: context.windowID) { [weak self] step in
            guard let self else { return }
            Log.info(String(format: "nav: step \"%@\" jev=%dms press=%dms", step.label, step.jevMs, step.pressMs))
            glide = Task { @MainActor in
                await self.overlay.chore(at: CGPoint(x: step.frame.midX, y: step.frame.midY), context: global, caption: step.label + "...")
            }
        }
        // Let the last callback (queued on the main actor) run before reading the glide task.
        await Task.yield()
        let arrived = result.final == "done" && !result.steps.isEmpty
        Log.info(String(format: "route: path=jev-nav final=%@ presses=%d script=%dms total=%.0fms steps=[%@] %@", result.final, result.steps.count,
                        result.totalMs, Date().timeIntervalSince(started) * 1000,
                        result.steps.map { "\($0.label):\($0.jevMs)+\($0.pressMs)" }.joined(separator: ", "), result.reason))
        guard arrived, let last = result.steps.last else { return .fallback(moved: !result.steps.isEmpty) }
        await glide?.value
        var plan = Plan()
        plan.steps = [PlanStep(kind: .point(CGPoint(x: last.frame.midX, y: last.frame.midY)), label: last.label)]
        plan.say = "Here's \(last.label)"
        overlay.perform(plan, context: global, stay: stay)
        say(plan.say)
        Log.info(String(format: "nav: arrived at \"%@\" total=%.0fms", last.label, Date().timeIntervalSince(started) * 1000))
        return .handled
    }

    private func logPoint(_ path: String, started: Date) {
        Log.info(String(format: "ask->point: path=%@ %.0fms", path, Date().timeIntervalSince(started) * 1000))
    }

    private enum ReplayOutcome {
        case done
        /// `ran`: chore phases already carried out; `moved`: the screen may have changed.
        case failed(ran: [CachedPhase], moved: Bool)
    }

    /// Runs a cached plan with no model call. Any step that cannot be resolved or run ends in
    /// `.failed`, and the caller asks Terra live.
    private func replay(_ entry: CachedPlan, context: ScreenContext, hook: AppHook?, stay: Bool, started: Date) async throws -> ReplayOutcome {
        var ctx = context
        var ran: [CachedPhase] = []
        for phase in entry.phases {
            if !phase.actions.isEmpty {
                let request = PlanCache.request(phase, context: ctx)
                guard !request.actions.isEmpty else { return .failed(ran: ran, moved: !ran.isEmpty) }
                let doing = (request.actions.first?.description ?? "One sec") + "..."
                await overlay.chore(at: request.actions.compactMap(\.point).first, context: ctx, caption: doing)
                try Task.checkCancellation()
                let undo: UndoRecord
                do {
                    undo = try await Executor.run(request, context: ctx, hook: hook)
                } catch {
                    Log.info("plan-cache: chore failed: \(error.localizedDescription)")
                    return .failed(ran: ran, moved: true)
                }
                ran.append(phase)
                Log.info("did (cached): \(request.announce)")
                overlay.setCaption(request.announce)
                overlay.showUndo(undo)
                say(request.announce)
                try await Task.sleep(nanoseconds: 300_000_000)
                ctx = try await Capture.capture(context.target)
            } else {
                var plan = Plan()
                plan.say = phase.say
                for cached in phase.steps {
                    guard let step = PlanCache.resolve(cached, context: ctx) else {
                        Log.info("plan-cache: could not resolve \"\(cached.axLabel ?? cached.label)\"")
                        return .failed(ran: ran, moved: !ran.isEmpty)
                    }
                    plan.steps.append(step)
                }
                logPoint("cache", started: started)
                overlay.perform(plan, context: ctx, stay: stay)
                say(plan.say)
                ran.append(phase)
            }
        }
        return .done
    }

    /// Plan-cache trust: saves only plans used without Undo, deletes a replayed one on Undo.
    private let trust = PlanTrust()

    /// Points, or does chores (then looks again and points), or does the step when asked to.
    /// Returns what to cache: the phases of this answer, or nil when it must not be replayed.
    private func carryOut(_ plan: Plan, question: String, context: ScreenContext, ask: AskContext,
                          hook: AppHook?, stay: Bool, started: Date) async throws -> [CachedPhase]? {
        guard var request = plan.doRequest else {
            // A long Linear explanation stays up until dismissed (Esc or click) instead of fading at 2 s.
            let explain = hook?.name == "Linear" && ((plan.say?.count ?? 0) > 90 || plan.say?.contains("\n") == true)
            overlay.perform(plan, context: context, stay: stay, hold: explain)
            logPoint("terra", started: started)
            say(plan.say)
            return plan.steps.isEmpty ? nil : [PlanCache.phase(from: plan, context: context)]
        }
        if request.coreStep && !ask.userAskedToDo {
            // The model wanted to do the very thing being taught: drop the actions, teach instead.
            Log.info("refused core step without permission: \(request.announce)")
            var teaching = plan
            teaching.doRequest = nil
            if teaching.say == nil { teaching.say = request.announce }
            overlay.perform(teaching, context: context, stay: stay)
            say(teaching.say)
            return nil
        }
        request = DoRequest(announce: request.announce, coreStep: request.coreStep, actions: Array(request.actions.prefix(6)))
        let choresPhase = PlanCache.choresPhase(request, say: plan.say, context: context)
        let point = request.actions.compactMap(\.point).first
        let doing = (request.actions.first?.description ?? (request.coreStep ? "On it" : "One sec")) + "..."
        await overlay.chore(at: point, context: context, caption: doing)
        try Task.checkCancellation()
        let undo: UndoRecord
        do {
            undo = try await Executor.run(request, context: context, hook: hook)
        } catch {
            Log.info("do failed: \(error.localizedDescription)")
            overlay.showMessage("I couldn't do that: \(error.localizedDescription)", near: nil)
            return nil
        }
        Log.info("did: \(request.announce) (core=\(request.coreStep))")
        overlay.setCaption(request.announce)
        overlay.showUndo(undo)
        say(request.announce)

        if request.coreStep {
            overlay.perform(Plan(say: request.announce), context: context, stay: stay)
            return nil
        }
        // Blender mode switch planned together with the point (one Terra turn): the hook confirms the
        // mode, then point where the model predicted, with no second screenshot or plan.
        if hook is BlenderHook, !plan.steps.isEmpty, let mode = Self.modeSwitch(request) {
            let state = await hook?.sceneState() ?? ""
            let now = state.split(separator: "\n").first { $0.hasPrefix("Mode: ") }.map { String($0.dropFirst(6)) } ?? "?"
            if Self.mode(now, matches: mode) {
                var pointing = plan
                pointing.doRequest = nil
                Log.info(String(format: "chore+point in one turn: mode_set(%@) verified by hook (Mode: %@), pointing at %@ without a second plan, %.0fms",
                                mode, now, plan.steps.map(\.label).joined(separator: ", "), Date().timeIntervalSince(started) * 1000))
                overlay.perform(pointing, context: context, stay: stay)
                logPoint("terra-one-turn", started: started)
                say(pointing.say)
                guard let choresPhase else { return nil }
                return [choresPhase, PlanCache.phase(from: pointing, context: context)]
            }
            Log.info("chore+point in one turn: hook says Mode: \(now), wanted \(mode); looking again")
        }
        // A chore cleared the way: look again and point at what the user asked about.
        try await Task.sleep(nanoseconds: 300_000_000)
        async let state = hook?.sceneState()
        let fresh = try await Capture.capture(context.target)
        var next = ask
        next.sceneState = await state
        next.note = "You just did a chore for the user: \(request.announce). Do not call do() again. " +
            "Now point at what the user asked about, on this fresh screenshot."
        var plan2 = try await brain.plan(question: question, context: fresh, ask: next)
        try Task.checkCancellation()
        plan2.doRequest = nil
        Log.info("plan after chore: \(plan2.summary)")
        overlay.perform(plan2, context: fresh, stay: stay)
        logPoint("terra", started: started)
        say(plan2.say)
        guard let choresPhase, !plan2.steps.isEmpty else {
            if choresPhase == nil { Log.info("plan-cache: not saved (chore outside the safe set)") }
            return nil
        }
        return [choresPhase, PlanCache.phase(from: plan2, context: fresh)]
    }

    /// The mode a chore switches Blender to, when the chore is only `bpy.ops.object.mode_set(mode='X')`.
    private static func modeSwitch(_ request: DoRequest) -> String? {
        guard request.actions.count == 1, let action = request.actions.first, action.kind == .blenderPython,
              let code = action.code?.trimmingCharacters(in: .whitespacesAndNewlines),
              let regex = try? NSRegularExpression(pattern: #"^bpy\.ops\.object\.mode_set\(\s*mode\s*=\s*['"]([A-Z_]+)['"]\s*\)$"#),
              let match = regex.firstMatch(in: code, range: NSRange(code.startIndex..., in: code)),
              let range = Range(match.range(at: 1), in: code) else { return nil }
        return String(code[range])
    }

    /// bpy.context.mode names differ from mode_set's ('EDIT' -> 'EDIT_MESH', 'VERTEX_PAINT' -> 'PAINT_VERTEX').
    private static func mode(_ contextMode: String, matches setMode: String) -> Bool {
        switch setMode {
        case "EDIT": return contextMode.hasPrefix("EDIT")
        case "VERTEX_PAINT": return contextMode == "PAINT_VERTEX"
        case "WEIGHT_PAINT": return contextMode == "PAINT_WEIGHT"
        case "TEXTURE_PAINT": return contextMode == "PAINT_TEXTURE"
        default: return contextMode == setMode || contextMode.hasPrefix(setMode)
        }
    }
}
