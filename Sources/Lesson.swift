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
    /// Points for upcoming steps, planned while the user works on the step before; stored by meaning
    /// (AX label or window fraction) so they can be found again on the changed screen without Terra.
    private var prepared: [Int: Task<CachedPhase?, Never>] = [:]
    /// When the last step was checked off (or next/skip said): the next point is timed from here.
    private var advancedAt: Date?

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
        dropPrepared()
        advancedAt = nil
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
                let (title, planned) = try await self.brain.planLesson(goal: goal, context: context, ask: ask)
                try Task.checkCancellation()
                self.goal = title
                Log.info("lesson plan: " + planned.enumerated().map { "\($0 + 1). \($1.title) [\($1.doneCheck ?? "manual")]" }.joined(separator: " "))
                let steps = await self.vet(planned, sceneState: ask.sceneState)
                try Task.checkCancellation()
                self.steps = steps
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
        dropPrepared()
        isActive = false
        checklist.close()
    }

    private func cancelTasks() {
        work?.cancel()
        poll?.cancel()
        work = nil
        poll = nil
    }

    private func dropPrepared() {
        prepared.values.forEach { $0.cancel() }
        prepared = [:]
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
        let ahead = prepared.removeValue(forKey: i)
        // Work out the next step's point now, while the user is busy with this one.
        if i + 1 < steps.count, prepared[i + 1] == nil { prepared[i + 1] = prepare(i + 1) }
        let since = advancedAt
        work = Task { [weak self] in
            guard let self else { return }
            let ms = { since.map { String(format: "%.0fms", Date().timeIntervalSince($0) * 1000) } ?? "first step" }
            if let ahead {
                let waited = Date()
                if let phase = await ahead.value, let (plan, context, via) = await self.relocate(phase) {
                    guard !Task.isCancelled, self.index == i else { return }
                    Log.info(String(format: "lesson point step %d: prefetched (%@, waited %.0fms) %@ after the check",
                                    i + 1, via, Date().timeIntervalSince(waited) * 1000, ms()))
                    self.overlay.perform(plan, context: context, stay: false)
                    if let say = plan.say { self.speak(say) }
                    return
                }
                Log.info("lesson point step \(i + 1): prefetched target gone or prefetch failed, asking terra")
            }
            do {
                let (context, ask) = try await self.look(note: self.stepNote(i, ahead: false))
                var plan = try await self.brain.plan(question: step.instruction, context: context, ask: ask)
                try Task.checkCancellation()
                guard self.index == i else { return }
                plan.doRequest = nil
                if plan.say == nil { plan.say = step.instruction }
                Log.info(String(format: "lesson point step %d: terra %@ after the check, %@", i + 1, ms(), plan.summary))
                self.overlay.perform(plan, context: context, stay: false)
                if let say = plan.say { self.speak(say) }
            } catch is CancellationError {
            } catch {
                Log.info("lesson step failed: \(error.localizedDescription)")
                self.overlay.showMessage(step.instruction, near: nil)
            }
        }
    }

    private func stepNote(_ i: Int, ahead: Bool) -> String {
        let step = steps[i]
        if ahead, i > 0 {
            return """
            Lesson "\(goal)": the user is doing step \(i) of \(steps.count) right now: \(steps[i - 1].instruction)
            Plan the NEXT step, step \(i + 1): \(step.instruction)
            Point at where they will do step \(i + 1) once step \(i) is done (the screen may change a little when \
            step \(i) is done, e.g. Edit Mode shows the mesh; aim where that control or object will be) and say the \
            instruction for step \(i + 1). Do not call do(): the user does it.
            """
        }
        return """
        Lesson "\(goal)": the user is on step \(i + 1) of \(steps.count): \(step.instruction)
        Point at where they do this step and say the instruction. Do not call do(): the user does it.
        """
    }

    /// Plans step `i`'s point and caption from the current screen; the result is saved by meaning.
    private func prepare(_ i: Int) -> Task<CachedPhase?, Never> {
        let started = Date()
        return Task { [weak self] in
            guard let self else { return nil }
            do {
                let (context, ask) = try await self.look(note: self.stepNote(i, ahead: true))
                let plan = try await self.brain.plan(question: self.steps[i].instruction, context: context, ask: ask)
                try Task.checkCancellation()
                var phase = PlanCache.phase(from: plan, context: context)
                if phase.say == nil { phase.say = self.steps[i].instruction }
                Log.info(String(format: "lesson prefetch step %d: ready in %.0fms, %@ [%@]", i + 1,
                                Date().timeIntervalSince(started) * 1000, plan.summary,
                                phase.steps.map { $0.axLabel.map { "ax:\($0)" } ?? "fraction" }.joined(separator: ",")))
                return phase.steps.isEmpty ? nil : phase
            } catch {
                if !(error is CancellationError) { Log.info("lesson prefetch step \(i + 1) failed: \(error.localizedDescription)") }
                return nil
            }
        }
    }

    /// Finds a prefetched point on the screen as it is now, cheaply: the window's frame from the window
    /// list plus, only when the point landed on a labelled control, a fresh AX walk. No screenshot, no
    /// model. nil when the window changed shape or the labelled control is gone.
    private func relocate(_ phase: CachedPhase) async -> (Plan, ScreenContext, String)? {
        guard let target, let window = Capture.frontWindow(pid: target.pid) else { return nil }
        let pid = target.pid
        let needsAX = phase.steps.contains { $0.axLabel != nil }
        let lines = needsAX
            ? await Task.detached { AXTree.lines(pid: pid, windowFrame: window.frame, scale: 1) }.value
            : []
        let context = ScreenContext(target: target, windowTitle: window.title, windowFrame: window.frame, windowID: window.id,
                                    jpeg: Data(), imageSize: window.frame.size, scale: 1, axLines: lines, backend: "lesson-relocate")
        var plan = Plan(say: phase.say)
        for cached in phase.steps {
            guard let step = PlanCache.resolve(cached, context: context) else {
                Log.info("lesson relocate: \"\(cached.axLabel ?? cached.label)\" not on screen any more")
                return nil
            }
            plan.steps.append(step)
        }
        return (plan, context, needsAX ? "ax label" : "window fraction")
    }

    /// Only the current step's check runs, so steps finish one at a time and in order. A check that is
    /// already true the moment its step starts (the step before did it too) would tick the step off by
    /// itself: that step waits for "next" instead. Every result is logged when it changes.
    private func startPolling(_ step: LessonStep, index i: Int) {
        poll?.cancel()
        let hook = self.hook
        let pid = target?.pid
        if hook != nil, step.doneCheck == nil {
            poll = nil
            return waitForNext(i, why: "no usable check")
        }
        poll = Task { [weak self] in
            var baseline: Int?
            var last: Bool??
            while !Task.isCancelled {
                if last != nil || baseline != nil { try? await Task.sleep(nanoseconds: 500_000_000) }
                guard !Task.isCancelled else { return }
                var done = false
                if let hook, let check = step.doneCheck {
                    let result = await hook.check(check)
                    guard !Task.isCancelled else { return }
                    if last == nil, result == true {
                        Log.info("lesson check step \(i + 1): YES already at step start, rejected for \(check)")
                        self?.waitForNext(i, why: "check already true at step start")
                        return
                    }
                    if last == nil || last! != result {
                        Log.info("lesson check step \(i + 1): \(Self.describe(result))\(last == nil ? " at step start" : "") for \(check)")
                    }
                    last = .some(result)
                    done = result == true
                } else if let pid {
                    // No hook: any change in the window's controls counts as progress.
                    let lines = await Task.detached { () -> [String] in
                        guard let w = Capture.frontWindow(pid: pid) else { return [] }
                        return AXTree.lines(pid: pid, windowFrame: w.frame, scale: 1)
                    }.value
                    let fingerprint = lines.hashValue
                    if let baseline, !lines.isEmpty { done = fingerprint != baseline }
                    if baseline == nil, !lines.isEmpty { baseline = fingerprint }
                    if baseline == nil { try? await Task.sleep(nanoseconds: 500_000_000) }
                }
                if done {
                    self?.completed(i)
                    return
                }
            }
        }
    }

    private static func describe(_ result: Bool?) -> String {
        result.map { $0 ? "YES" : "NO" } ?? "ERR"
    }

    private func waitForNext(_ i: Int, why: String) {
        guard isActive, index == i else { return }
        Log.info("lesson step \(i + 1): \(why), waits for next or Skip")
        overlay.showStepPill("Step \(i + 1) of \(steps.count)  ·  \(steps[i].title)  ·  say next when done")
    }

    /// A model-written check that is already true (or errors) when the lesson is planned would tick its
    /// step off by itself: it is re-planned once from the live state, else that step waits for "next".
    private func vet(_ planned: [LessonStep], sceneState: String?) async -> [LessonStep] {
        guard let hook else { return planned }
        var steps = planned
        for (i, step) in planned.enumerated() {
            guard let check = step.doneCheck else { continue }
            let now = await hook.check(check)
            Log.info("lesson check step \(i + 1) at plan time: \(Self.describe(now)) for \(check)")
            guard now == false else {
                let why = now == true ? "it is already true now" : "it raised an error"
                var replacement: String?
                if let sceneState, let fresh = await brain.recheck(goal: goal, step: step, sceneState: sceneState,
                                                                   rejected: check, why: why, timeout: 6) {
                    let again = await hook.check(fresh)
                    Log.info("lesson check step \(i + 1) re-planned: \(Self.describe(again)) at plan time for \(fresh)")
                    if again == false { replacement = fresh }
                }
                steps[i].doneCheck = replacement
                if replacement == nil { Log.info("lesson check step \(i + 1) rejected (\(why)): waits for next") }
                continue
            }
        }
        return steps
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
        advancedAt = Date()
        if skipped { checklist.markSkipped(index) } else { checklist.markDone(index) }
        if index + 1 < steps.count {
            show(index + 1)
        } else {
            finish(message: "Nice, you did it: \(goal)!", completedAll: true)
        }
    }

    private func finish(message: String, completedAll: Bool = false) {
        cancelTasks()
        dropPrepared()
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
