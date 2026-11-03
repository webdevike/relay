import Cocoa

/// "Teach me to <goal>" / "walk me through <goal>": plans steps (a built-in recipe, else the model), points
/// at each and moves on by itself when the app's live state shows a step done (hook checks, e.g. Blender
/// scene state; otherwise a change in the window's AX tree), jumping ahead when the user ran ahead of the
/// list. "next"/"skip" in the bubble move on by hand; "stop" or Esc ends it.
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
        checklist.onStop = { [weak self] in _ = self?.handleCommand("stop") }
    }

    /// The goal of an ask for a walkthrough ("teach me to X", "walk me through making X", "can you show me
    /// how to X", "X step by step"); nil when it is not one. `learnable`: the app has a live hook (Blender),
    /// where a plain "how do I X" is a lesson too, not a one-line answer mixing shortcuts and tools.
    nonisolated static func goal(in question: String, learnable: Bool) -> String? {
        func first(_ pattern: String, in text: String) -> String? {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
                  let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
                  let range = Range(match.range(at: 1), in: text) else { return nil }
            return String(text[range])
        }
        func tidy(_ goal: String) -> String? {
            let trimmed = goal.replacingOccurrences(of: #"(?:,?\s+(?:please|step[- ]by[- ]step|in blender))+\s*[.?!]*\s*$"#,
                                                    with: "", options: [.regularExpression, .caseInsensitive])
                .trimmingCharacters(in: CharacterSet(charactersIn: " ,.?!"))
            return trimmed.isEmpty ? nil : trimmed
        }
        // "hey", "so", "can you", "could you please": politeness in front of the ask.
        let lead = #"^\s*(?:(?:hey|hi|so|ok|okay|um|alright|please)[\s,]+)*(?:(?:can|could|would|will) you\s+)?(?:please\s+)?"#
        let q = question.replacingOccurrences(of: lead, with: "", options: [.regularExpression, .caseInsensitive])
        let lesson = #"^(?:teach me(?: how)?(?: to)?|(?:walk|talk|guide|take) me through(?: how to)?|show me(?: step[- ]by[- ]step)? how to|help me learn(?: how)? to|i want to learn(?: how)? to|lesson:?)\s+(.+)$"#
        if let goal = first(lesson, in: q) { return tidy(goal) }
        // "I want to make a donut, walk me through it" / "make a donut step by step".
        let trailing = #"^(.+?)[\s,]+(?:(?:can you\s+)?(?:walk|talk|guide|take) me through it|step[- ]by[- ]step)\s*[.?!]*$"#
        if let goal = first(trailing, in: q) {
            return tidy(goal.replacingOccurrences(of: #"^(?:i (?:want|need|would like|'d like) to|how (?:do|can) i|how to)\s+"#,
                                                  with: "", options: [.regularExpression, .caseInsensitive]))
        }
        guard learnable else { return nil }
        let howTo = #"^(?:how (?:do|can|would|should) i|how to|how do you|how would i go about)\s+(.+)$"#
        return first(howTo, in: q).flatMap(tidy)
    }

    /// "stop", "stop talking", "be quiet": ends the lesson, or just her speech when no lesson runs.
    nonisolated static func isStop(_ text: String) -> Bool {
        let said = text.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: " .!?,"))
        return ["stop", "stop it", "stop talking", "be quiet", "quiet", "shush", "hush", "end lesson", "stop lesson",
                "quit lesson", "stop the lesson", "end the lesson"].contains(said)
    }

    /// Lesson words typed or spoken while a lesson runs; true when handled.
    func handleCommand(_ text: String) -> Bool {
        guard isActive else { return false }
        let said = text.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: " .!?"))
        if Self.isStop(said) {
            finish(message: "Lesson stopped. Ask me anything.")
            return true
        }
        switch said {
        case "next", "next step", "done":
            Log.info("lesson: \(text) on step \(index + 1)")
            if !steps.isEmpty { advance(skipped: false) }
            return true
        case "skip", "skip it":
            Log.info("lesson: \(text) on step \(index + 1)")
            if !steps.isEmpty { advance(skipped: true) }
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
        index = 0
        lastMet = [:]
        overlay.showThinking(near: NSEvent.mouseLocation, appName: target.name)
        overlay.setCaption("Planning a lesson: \(goal)")
        let recipe = LessonRecipes.match(goal: goal, hook: hook)
        Log.info("lesson start: \"\(goal)\" in \(target.name), plan from \(recipe.map { "recipe \($0.title)" } ?? "terra")")
        work = Task { [weak self] in
            guard let self else { return }
            do {
                var title = goal
                let steps: [LessonStep]
                if let recipe {
                    title = recipe.title
                    steps = recipe.steps
                    Log.info("lesson plan: " + Self.describe(steps))
                } else {
                    let (context, ask, _) = try await self.look(note: nil)
                    let planned = try await self.brain.planLesson(goal: goal, context: context, ask: ask)
                    try Task.checkCancellation()
                    title = planned.0
                    Log.info("lesson plan: " + Self.describe(planned.1))
                    steps = await self.vet(planned.1, sceneState: ask.sceneState)
                }
                try Task.checkCancellation()
                self.goal = title
                self.steps = steps
                self.checklist.show(assistant: self.assistant, goal: title, steps: steps,
                                    windowFrame: Capture.frontWindow(pid: target.pid)?.frame)
                // Steps the app already shows done (a torus from before) are ticked; the lesson starts after them.
                let done = await self.reachedNow(from: 0)
                try Task.checkCancellation()
                guard let done else { return self.show(0) }
                Log.info("lesson start: the app already shows steps 1-\(done + 1) done")
                self.reached(done, from: 0)
            } catch is CancellationError {
            } catch {
                Log.info("lesson failed: \(error.localizedDescription)")
                self.isActive = false
                self.overlay.showMessage(error.localizedDescription, near: nil)
            }
        }
    }

    private static func describe(_ steps: [LessonStep]) -> String {
        steps.enumerated().map { "\($0 + 1). \($1.title) [\($1.doneCheck ?? "manual")\($1.lasting ? "" : ", passes")]" }
            .joined(separator: " ")
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

    private func look(note: String?) async throws -> (ScreenContext, AskContext, BlenderLayout?) {
        guard let target else { throw CaptureError.noWindow("the app") }
        async let state = hook?.sceneState()
        async let layoutRaw = (hook as? BlenderHook)?.layout()
        let context = try await Capture.capture(target)
        var ask = AskContext(sceneState: await state, hookName: hook?.name, hookNotes: hook?.promptNotes,
                             userAskedToDo: false, note: note)
        let layout = BlenderLayout(await layoutRaw, context: context)
        if let layout { ask.sceneState = (ask.sceneState.map { $0 + "\n" } ?? "") + layout.prompt }
        return (context, ask, layout)
    }

    /// Step `i` becomes current: its instruction is spoken and captioned at once (a smooth handoff from the
    /// step before, never a silent wait for the model), then the cursor points once the point is ready.
    private func show(_ i: Int) {
        index = i
        let step = steps[i]
        checklist.setCurrent(i)
        Log.info("lesson step \(i + 1)/\(steps.count): \(step.instruction)")
        overlay.showMessage(step.instruction, near: nil)
        speak(step.instruction)
        startPolling(from: i)
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
                    var plan = plan
                    plan.say = step.instruction
                    self.overlay.perform(plan, context: context, stay: false, stepNumber: i + 1)
                    return
                }
                Log.info("lesson point step \(i + 1): prefetched target gone or prefetch failed, asking terra")
            }
            do {
                let (context, ask, layout) = try await self.look(note: self.stepNote(i, ahead: false))
                var plan = try await self.brain.plan(question: step.instruction, context: context, ask: ask)
                if let layout { plan.steps = layout.refine(plan.steps) }
                try Task.checkCancellation()
                guard self.index == i else { return }
                plan.doRequest = nil
                plan.say = step.instruction
                Log.info(String(format: "lesson point step %d: terra %@ after the check, %@", i + 1, ms(), plan.summary))
                self.overlay.perform(plan, context: context, stay: false, stepNumber: i + 1)
            } catch is CancellationError {
            } catch {
                if !Task.isCancelled { Log.info("lesson step failed: \(error.localizedDescription)") }
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
                let (context, ask, layout) = try await self.look(note: self.stepNote(i, ahead: true))
                var plan = try await self.brain.plan(question: self.steps[i].instruction, context: context, ask: ask)
                if let layout { plan.steps = layout.refine(plan.steps) }
                try Task.checkCancellation()
                var phase = PlanCache.phase(from: plan, context: context)
                if phase.say == nil { phase.say = self.steps[i].instruction }
                Log.info(String(format: "lesson prefetch step %d: ready in %.0fms, %@ [%@]", i + 1,
                                Date().timeIntervalSince(started) * 1000, plan.summary,
                                phase.steps.map { $0.axLabel.map { "ax:\($0)" } ?? "fraction" }.joined(separator: ",")))
                return phase.steps.isEmpty ? nil : phase
            } catch {
                if !Task.isCancelled, !(error is CancellationError) { Log.info("lesson prefetch step \(i + 1) failed: \(error.localizedDescription)") }
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

    /// Watches the app until it shows a step from `i` on done, then moves there by itself. With a hook,
    /// every remaining step's check is read each poll (one round trip), so a user who runs ahead of the
    /// list is followed (LessonProgress); a step with no check is done once the scene changes at all.
    /// Without a hook, any change in the window's controls counts as the step done.
    private func startPolling(from i: Int) {
        poll?.cancel()
        let pid = target?.pid
        poll = Task { [weak self] in
            guard let self else { return }
            if let hook = self.hook {
                let baseline = self.steps[i].doneCheck == nil ? await hook.snapshot() : nil
                var previous: String?
                while !Task.isCancelled {
                    if let reached = await self.reachedNow(from: i) {
                        guard !Task.isCancelled else { return }
                        return self.reached(reached, from: i)
                    }
                    if let baseline, let now = await hook.snapshot() {
                        guard !Task.isCancelled else { return }
                        // Changed and settled (the same on two polls, not mid-drag).
                        if now != baseline, now == previous {
                            Log.info("lesson step \(i + 1): the scene changed (this step has no check)")
                            return self.reached(i, from: i)
                        }
                        previous = now
                    }
                    try? await Task.sleep(nanoseconds: 500_000_000)
                }
            } else if let pid {
                var baseline: Int?
                while !Task.isCancelled {
                    let lines = await Task.detached { () -> [String] in
                        guard let w = Capture.frontWindow(pid: pid) else { return [] }
                        return AXTree.lines(pid: pid, windowFrame: w.frame, scale: 1)
                    }.value
                    guard !Task.isCancelled else { return }
                    if !lines.isEmpty {
                        if let baseline, lines.hashValue != baseline {
                            Log.info("lesson step \(i + 1): the window's controls changed")
                            return self.reached(i, from: i)
                        }
                        if baseline == nil { baseline = lines.hashValue }
                    }
                    try? await Task.sleep(nanoseconds: 500_000_000)
                }
            }
        }
    }

    /// Last result of each step's check this lesson, so each is logged once per change.
    private var lastMet: [Int: Bool?] = [:]

    /// Reads every check from step `i` on against one moment of the app and returns the furthest step
    /// done (LessonProgress); nil when none is, or the user is mid-operation.
    private func reachedNow(from i: Int) async -> Int? {
        guard let hook, i < steps.count else { return nil }
        let pending = (i..<steps.count).filter { steps[$0].doneCheck != nil }
        guard let results = await hook.checks(pending.compactMap { steps[$0].doneCheck }) else { return nil }
        var met = [Bool?](repeating: nil, count: steps.count)
        var changes: [String] = []
        for (k, result) in zip(pending, results) {
            met[k] = result
            if lastMet[k] == nil || lastMet[k]! != result { changes.append("\(k + 1)=\(Self.describe(result))") }
            lastMet[k] = .some(result)
        }
        if !changes.isEmpty { Log.info("lesson checks (on step \(i + 1)): " + changes.joined(separator: " ")) }
        return LessonProgress.reached(from: i, met: met, lasting: steps.map(\.lasting))
    }

    private static func describe(_ result: Bool?) -> String {
        result.map { $0 ? "YES" : "NO" } ?? "ERR"
    }

    /// A model-written check that is already true (or errors) when the lesson is planned would tick its
    /// step off by itself: it is re-planned once from the live state, else that step has no check and is
    /// done on the next scene change.
    private func vet(_ planned: [LessonStep], sceneState: String?) async -> [LessonStep] {
        guard let hook else { return planned }
        var steps = planned
        for (i, step) in planned.enumerated() {
            guard let check = step.doneCheck else { continue }
            let now = await hook.check(check)
            Log.info("lesson check step \(i + 1) at plan time: \(Self.describe(now)) for \(check)")
            guard !LessonProgress.usableAtPlanTime(now) else { continue }
            let why = now == true ? "it is already true now" : "it raised an error"
            var replacement: String?
            if let sceneState, let fresh = await brain.recheck(goal: goal, step: step, sceneState: sceneState,
                                                               rejected: check, why: why, timeout: 6) {
                let again = await hook.check(fresh)
                Log.info("lesson check step \(i + 1) re-planned: \(Self.describe(again)) at plan time for \(fresh)")
                if LessonProgress.usableAtPlanTime(again) { replacement = fresh }
            }
            steps[i].doneCheck = replacement
            if replacement == nil { Log.info("lesson check step \(i + 1) rejected (\(why)): done on the next scene change") }
        }
        return steps
    }

    /// The app shows step `j` done while step `i` is current: ticks `i` through `j` and moves on.
    private func reached(_ j: Int, from i: Int) {
        guard isActive, index == i else { return }
        if j == i {
            Log.info("lesson step \(i + 1) done")
        } else {
            Log.info("lesson skip-ahead: the app already shows step \(j + 1) done while on step \(i + 1); ticking steps \(i + 1)-\(j + 1)")
        }
        for k in i..<j { checklist.markDone(k) }
        for k in Array(prepared.keys) where k <= j { prepared.removeValue(forKey: k)?.cancel() }
        index = j
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
        overlay.showMessage(message, near: nil)
        speak(message)
    }
}

/// Where a lesson stands, from each step's check against the app's live state. From the current step
/// on, a met step counts as reached; an unmet step whose state lasts (a torus, a modifier) ends the walk,
/// since everything after it builds on it; an unmet step whose state passes (a mode or a selection the
/// next steps leave), or a step with no check (nil), is passed over. So a user who runs ahead of the list
/// is followed to the furthest step their scene shows, while a stray Edit Mode on step 2 jumps nowhere.
enum LessonProgress {
    /// The furthest step from `current` on that the state shows done, or nil when none is.
    static func reached(from current: Int, met: [Bool?], lasting: [Bool]) -> Int? {
        guard current < met.count else { return nil }
        var reached: Int?
        for k in current..<met.count {
            switch met[k] {
            case true?: reached = k
            case false? where lasting[k]: return reached
            default: continue
            }
        }
        return reached
    }

    /// A model-planned check is kept only when it is false right now (true already, or an error, would
    /// tick its step off by itself or never).
    static func usableAtPlanTime(_ result: Bool?) -> Bool { result == false }
}
