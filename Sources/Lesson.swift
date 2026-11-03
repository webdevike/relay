import Cocoa

/// "Teach me to <goal>": plans steps with the model, points at each, and advances when the step is
/// done (hook check, e.g. Blender scene state; otherwise a change in the window's AX tree), or on
/// "next"/"skip" in the bubble. "stop" ends it.
@MainActor
final class LessonController {
    private let brain: Brain
    private let overlay: OverlayController
    var speak: (String) -> Void = { _ in }

    private(set) var isActive = false
    private var goal = ""
    private var steps: [LessonStep] = []
    private var index = 0
    private var target: TargetApp?
    private var hook: AppHook?
    private var work: Task<Void, Never>?
    private var poll: Task<Void, Never>?

    private let checklist = LessonChecklist()
    private var assistant = Assistants.personal

    init(brain: Brain, overlay: OverlayController) {
        self.brain = brain
        self.overlay = overlay
        checklist.onSkip = { [weak self] in _ = self?.handleCommand("skip") }
        checklist.onStop = { [weak self] in _ = self?.handleCommand("stop") }
    }

    /// Matches "teach me to X", "teach me how to X", "lesson: X"; returns X.
    static func goal(in question: String) -> String? {
        let pattern = #"^\s*(?:please\s+)?(?:teach me(?: how)? to|lesson:?|show me how to)\s+(.+)$"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = regex.firstMatch(in: question, range: NSRange(question.startIndex..., in: question)),
              let range = Range(match.range(at: 1), in: question) else { return nil }
        return question[range].trimmingCharacters(in: CharacterSet(charactersIn: " .?!"))
    }

    /// Lesson words typed or spoken while a lesson runs; true when handled.
    func handleCommand(_ text: String) -> Bool {
        guard isActive else { return false }
        switch text.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: " .!?")) {
        case "next", "next step", "done":
            Log.info("lesson: \(text) on step \(index + 1)")
            if !steps.isEmpty { advance(skipped: false) }
            return true
        case "skip", "skip it":
            Log.info("lesson: \(text) on step \(index + 1)")
            if !steps.isEmpty { advance(skipped: true) }
            return true
        case "stop", "end lesson", "stop lesson", "quit lesson":
            finish(message: "Lesson stopped. Ask me anything.")
            return true
        default:
            return false
        }
    }

    func start(goal: String, target: TargetApp, assistant: Assistant) {
        cancelTasks()
        checklist.close()
        isActive = true
        self.goal = goal
        self.assistant = assistant
        self.target = target
        hook = AppHooks.hook(for: target)
        steps = []
        overlay.showThinking(near: NSEvent.mouseLocation, appName: target.name)
        overlay.setCaption("Planning a lesson: \(goal)")
        work = Task { [weak self] in
            guard let self else { return }
            do {
                let (context, ask) = try await self.look(note: nil)
                let (title, steps) = try await self.brain.planLesson(goal: goal, context: context, ask: ask)
                try Task.checkCancellation()
                self.goal = title
                self.steps = steps
                Log.info("lesson plan: " + steps.enumerated().map { "\($0 + 1). \($1.title) [\($1.doneCheck ?? "manual")]" }.joined(separator: " "))
                self.checklist.show(assistant: self.assistant, goal: title, steps: steps,
                                    windowFrame: Capture.frontWindow(pid: target.pid)?.frame)
                self.show(0)
            } catch is CancellationError {
            } catch {
                Log.info("lesson failed: \(error.localizedDescription)")
                self.isActive = false
                self.overlay.showMessage(error.localizedDescription, near: nil)
            }
        }
    }

    func stop() {
        guard isActive else { return }
        cancelTasks()
        isActive = false
        checklist.close()
    }

    private func cancelTasks() {
        work?.cancel()
        poll?.cancel()
        work = nil
        poll = nil
    }

    private func look(note: String?) async throws -> (ScreenContext, AskContext) {
        guard let target else { throw CaptureError.noWindow("the app") }
        async let state = hook?.sceneState()
        let context = try await Capture.capture(target)
        let ask = AskContext(sceneState: await state, hookName: hook?.name, hookNotes: hook?.promptNotes,
                             userAskedToDo: false, note: note)
        return (context, ask)
    }

    private func show(_ i: Int) {
        index = i
        let step = steps[i]
        checklist.setCurrent(i)
        overlay.showStepPill("Step \(i + 1) of \(steps.count)  ·  \(step.title)")
        Log.info("lesson step \(i + 1)/\(steps.count): \(step.instruction)")
        startPolling(step, index: i)
        work = Task { [weak self] in
            guard let self else { return }
            do {
                let note = """
                Lesson "\(self.goal)": the user is on step \(i + 1) of \(self.steps.count): \(step.instruction)
                Point at where they do this step and say the instruction. Do not call do(): the user does it.
                """
                let (context, ask) = try await self.look(note: note)
                var plan = try await self.brain.plan(question: step.instruction, context: context, ask: ask)
                try Task.checkCancellation()
                guard self.index == i else { return }
                plan.doRequest = nil
                if plan.say == nil { plan.say = step.instruction }
                Log.info(String(format: "lesson point step %d: %@", i + 1, plan.summary))
                self.overlay.perform(plan, context: context, stay: false)
                if let say = plan.say { self.speak(say) }
            } catch is CancellationError {
            } catch {
                Log.info("lesson step failed: \(error.localizedDescription)")
                self.overlay.showMessage(step.instruction, near: nil)
            }
        }
    }

    private func startPolling(_ step: LessonStep, index i: Int) {
        poll?.cancel()
        let hook = self.hook
        let pid = target?.pid
        poll = Task { [weak self] in
            var baseline: Int?
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled else { return }
                var done = false
                if let hook, let check = step.doneCheck {
                    done = await hook.check(check) == true
                } else if let pid {
                    // No hook: any change in the window's controls counts as progress.
                    let lines = await Task.detached { () -> [String] in
                        guard let w = Capture.frontWindow(pid: pid) else { return [] }
                        return AXTree.lines(pid: pid, windowFrame: w.frame, scale: 1)
                    }.value
                    let fingerprint = lines.hashValue
                    if let baseline, !lines.isEmpty { done = fingerprint != baseline }
                    if baseline == nil, !lines.isEmpty { baseline = fingerprint }
                }
                if done {
                    await MainActor.run { self?.completed(i) }
                    return
                }
            }
        }
    }

    private func completed(_ i: Int) {
        guard isActive, index == i else { return }
        Log.info("lesson step \(i + 1) done")
        advance(skipped: false)
    }

    /// Checks (or dashes) the current step, then points at the next one: caption, voice and cursor
    /// all fire again in show(), on every advance.
    private func advance(skipped: Bool) {
        cancelTasks()
        if skipped { checklist.markSkipped(index) } else { checklist.markDone(index) }
        if index + 1 < steps.count {
            show(index + 1)
        } else {
            finish(message: "Nice, you did it: \(goal)!", completedAll: true)
        }
    }

    private func finish(message: String, completedAll: Bool = false) {
        cancelTasks()
        isActive = false
        Log.info("lesson end: \(message)")
        if completedAll {
            checklist.celebrate(goal: goal, accent: assistant.accent)
        } else {
            checklist.close()
        }
        overlay.showStepPill("Lesson done  ·  \(goal)")
        overlay.showMessage(message, near: nil)
        speak(message)
    }
}
