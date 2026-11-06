import Foundation

// Behaviour tests for the rules Relay Assist decides by itself, without a model or the screen:
// who answers (AssistantRouter), the no-brain asks (Shortcut, Capabilities, Handoff), when a plan
// earns or loses its cache entry (PlanTrust), which asks start a lesson, and how the app's state ticks
// lesson steps off and jumps ahead (LessonProgress, the donut recipe).
// Built with the app's sources by `./build.sh test` (or `make test`); exits non-zero on a failure.

// Fixtures before any static reads them: a registry with three assistants, a scratch plan store and log.
let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("relay-assist-tests-\(getpid())")
try! FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
let registry = scratch.appendingPathComponent("agents.json")
try! Data(#"""
{"agents": [
  {"id": "astra", "title": "Astra", "profile": "work"},
  {"id": "nova", "title": "Nova", "profile": "personal"},
  {"id": "polaris", "title": "Polaris", "profile": "personal"}
]}
"""#.utf8).write(to: registry)
setenv("RELAY_ASSIST_REGISTRY", registry.path, 1)
setenv("RELAY_BUDDY_PLAN_FILE", scratch.appendingPathComponent("plans.json").path, 1)
setenv("RELAY_BUDDY_LOG", scratch.appendingPathComponent("test.log").path, 1)

nonisolated(unsafe) var passed = 0
nonisolated(unsafe) var failed: [String] = []

func expect(_ ok: Bool, _ name: String, line: Int = #line) {
    if ok { passed += 1 } else { failed.append("line \(line): \(name)") }
}

func expectEqual<T: Equatable>(_ got: T, _ want: T, _ name: String, line: Int = #line) {
    if got == want { passed += 1 } else { failed.append("line \(line): \(name): got \(got), want \(want)") }
}

let finder = TargetApp(pid: 0, name: "Finder", bundleID: "com.apple.finder")
let linear = TargetApp(pid: 0, name: "Linear", bundleID: "com.linear")

// MARK: AssistantRouter

func addressed(_ q: String) -> (String, String)? { AssistantRouter.addressed(q).map { ($0.0.id, $0.1) } }

expectEqual(addressed("Astra, what is this?")?.0, "astra", "a leading name picks that assistant")
expectEqual(addressed("Astra, what is this?")?.1, "what is this?", "the leading name is removed")
expectEqual(addressed("hey Nova where is Wi-Fi")?.1, "where is Wi-Fi", "hey <name> is removed")
expectEqual(addressed("where is Wi-Fi, Nova?")?.0, "nova", "a trailing name picks that assistant")
expectEqual(addressed("where is Wi-Fi, Nova?")?.1, "where is Wi-Fi?", "a trailing name is removed, punctuation kept")
expectEqual(addressed("ask Polaris about the weather")?.0, "polaris", "ask <name>")
expect(addressed("where's the supernova filter") == nil, "a name inside a word is not an address")
expect(addressed("where is the bevel tool") == nil, "no name, no address")

expect(AssistantRouter.ecardQuestion("what's blocking ENG-6309?")?.hasPrefix("question:issue-key") == true, "issue key is eCard work")
expect(AssistantRouter.ecardQuestion("open PR 12") == "question:PR", "PR is eCard work")
expect(AssistantRouter.ecardQuestion("the eCard platform") == "question:ecard", "ecard in any spelling")
expect(AssistantRouter.ecardQuestion("where is Wi-Fi") == nil, "Wi-Fi is not an issue key")
expect(AssistantRouter.ecardQuestion("how do I bevel") == nil, "plain question is not eCard work")

expectEqual(AssistantRouter.decide("what is this?", target: linear).assistant.id, "astra", "Linear in front goes to Astra")
expectEqual(AssistantRouter.decide("what is this?", target: linear).reason, "app:Linear", "Linear app rule")
expectEqual(AssistantRouter.decide("Nova, what is this?", target: linear).assistant.id, "nova", "a name beats the app rule")
expectEqual(AssistantRouter.decide("how do I make a folder", target: finder).assistant.id, "nova", "Finder defaults to Nova")
expectEqual(AssistantRouter.decide("open ENG-6309", target: finder).assistant.id, "astra", "an issue key in Finder goes to Astra")
let finderScreen = AssistantRouter.decide("", target: finder)
expectEqual(AssistantRouter.live("what's ENG-1", screen: finderScreen).id, "astra", "bubble re-routes on an issue key while typing")
expectEqual(AssistantRouter.live("Polaris, hi", screen: finderScreen).id, "polaris", "bubble re-routes on a name while typing")

// MARK: Shortcut

func linearKey(_ q: String) -> String? {
    if case .linear(let key) = Shortcut.match(q, target: nil) { return key }
    return nil
}
expectEqual(linearKey("open ENG-6309"), "ENG-6309", "open KEY opens Linear")
expectEqual(linearKey("pull up ENG-12 please"), "ENG-12", "pull up KEY")
expect(Shortcut.match("what is ENG-6309", target: nil) == nil, "a key without an open verb is a question, not a shortcut")
expect(Shortcut.match("show me the bevel tool", target: nil) == nil, "an open verb without a key or PR is not a shortcut")
expect(Shortcut.match("open PR 12", target: nil) == nil, "a PR number with no repo falls back to the normal path")
if case .pullRequest(let url) = Shortcut.match("open https://github.com/eCardSystems/app/pull/42", target: nil) {
    expectEqual(url.absoluteString, "https://github.com/eCardSystems/app/pull/42", "a PR URL opens as is")
} else {
    expect(false, "a PR URL is a pullRequest shortcut")
}

// MARK: Capabilities

for q in ["what can you do here?", "help", "Help me", "what can you help me with", "so what can you do in this app",
          "What could you do for me here?", "how can you help"] {
    expect(Capabilities.isAsking(q), "\"\(q)\" asks what she can do")
}
for q in ["help me bevel this", "what can you do with bevel", "can you help me find Wi-Fi", "where is help"] {
    expect(!Capabilities.isAsking(q), "\"\(q)\" is a real question, not a capabilities ask")
}
let blenderHelp = Capabilities.answer(app: "Blender", bundleID: "org.blenderfoundation.blender", hook: "Blender",
                                      navigates: false, inLesson: false, workAssistant: "Astra")
expect(blenderHelp.spoken.contains("step by step") && blenderHelp.spoken.contains("where's the bevel tool"),
       "Blender lists lessons and a bevel example")
let linearHelp = Capabilities.answer(app: "Linear", bundleID: "com.linear", hook: "Linear", navigates: false, inLesson: false,
                                     workAssistant: "Astra")
expect(linearHelp.spoken.contains("only read Linear") && linearHelp.spoken.contains("Astra"),
       "Linear says it is read-only and names who gets handoffs")
let settingsHelp = Capabilities.answer(app: "System Settings", bundleID: "com.apple.systempreferences", hook: nil,
                                       navigates: true, inLesson: false, workAssistant: "Astra")
expect(settingsHelp.spoken.contains("take you to the right screen") && settingsHelp.spoken.contains("where's Wi-Fi"),
       "an app Jev can walk offers navigation and its own example")
let noNav = Capabilities.answer(app: "Notes", bundleID: "com.apple.Notes", hook: nil, navigates: false, inLesson: false,
                                workAssistant: "Astra")
expect(!noNav.spoken.contains("take you") && !noNav.caption.contains("navigate"), "no navigation claimed where Jev can't")
let inLesson = Capabilities.answer(app: "Blender", bundleID: "org.blenderfoundation.blender", hook: "Blender",
                                   navigates: false, inLesson: true, workAssistant: "Astra")
expect(inLesson.spoken.hasPrefix("You're in a lesson"), "a running lesson is mentioned first")
for a in [blenderHelp, linearHelp, settingsHelp, noNav] {
    expect(a.caption.count <= 90, "caption fits one line (\(a.caption.count) chars): \(a.caption)")
    expect(!a.spoken.contains("\u{2014}") && !a.caption.contains("\u{2014}"), "no em dashes")
}

// MARK: Handoff

expectEqual(Handoff.intent(in: "TEST: remind me about this")?.kind, .remind, "remind me")
expectEqual(Handoff.intent(in: "TEST: remind me about this")?.test, true, "TEST is carried")
expectEqual(Handoff.intent(in: "make a ticket for this")?.kind, .ticket, "make a ticket")
expectEqual(Handoff.intent(in: "make a ticket for this")?.test, false, "no TEST word, not a test")
expectEqual(Handoff.intent(in: "hand this off to Astra")?.kind, .handoff, "hand this off")
expect(Handoff.intent(in: "where is the bevel tool") == nil, "a question is not a handoff")

// MARK: PlanCache keys and safety

expectEqual(PlanCache.normalize("Hey buddy, Where's the Bevel tool?"), "where is the bevel tool", "normalize")
func action(_ code: String) -> BuddyAction {
    BuddyAction(kind: .blenderPython, description: "Switch mode", point: nil, code: code, keys: nil, menuPath: nil)
}
expect(PlanCache.isSafe(action("bpy.ops.object.mode_set(mode='EDIT')")), "a mode switch may be replayed")
expect(!PlanCache.isSafe(action("bpy.ops.object.delete()")), "a delete is never replayed")
expect(!PlanCache.isSafe(BuddyAction(kind: .key, description: "Save", point: nil, code: nil, keys: ["cmd", "s"], menuPath: nil)),
       "Cmd+S is never replayed")

// MARK: Lesson routing

let blenderAsks: [(String, String)] = [
    ("Can you walk me through how to make a donut?", "make a donut"),
    ("walk me through making a donut", "making a donut"),
    ("Teach me how to add a torus.", "add a torus"),
    ("teach me to model a mug", "model a mug"),
    ("lesson: bevel the cube", "bevel the cube"),
    ("could you please show me how to make a donut in Blender?", "make a donut"),
    ("hey, can you guide me through making a donut please", "making a donut"),
    ("I want to make a donut, walk me through it", "make a donut"),
    ("make a donut step by step", "make a donut"),
    ("how do I make a donut?", "make a donut"),
    ("So how can I bevel this cube", "bevel this cube"),
]
for (ask, goal) in blenderAsks {
    expectEqual(LessonController.goal(in: ask, learnable: true), goal, "\"\(ask)\" starts a lesson in Blender")
}
expectEqual(LessonController.goal(in: "Can you walk me through how to make a donut?", learnable: false), "make a donut",
            "a walkthrough ask is a lesson in any app")
expect(LessonController.goal(in: "how do I make a folder", learnable: false) == nil, "a plain how-do-I outside Blender is an answer")
for ask in ["where is the bevel tool", "what is this?", "show me the bevel tool", "walk the dog", "can you help me find Wi-Fi"] {
    expect(LessonController.goal(in: ask, learnable: true) == nil, "\"\(ask)\" is not a lesson")
}
for said in ["stop", "Stop.", "stop talking", "be quiet", "end lesson"] { expect(LessonController.isStop(said), "\"\(said)\" stops her") }
for said in ["stop the bevel", "next", "don't stop"] { expect(!LessonController.isStop(said), "\"\(said)\" is not a stop") }

// MARK: LessonProgress

// Five steps; step 3 (index 2) is a mode that passes, the rest last.
let lasting = [true, true, false, true, true]
func reached(_ current: Int, _ met: [Bool?]) -> Int? { LessonProgress.reached(from: current, met: met, lasting: lasting) }
expectEqual(reached(0, [false, false, false, false, false]), nil, "nothing done yet, nothing reached")
expectEqual(reached(0, [true, false, false, false, false]), 0, "the current step done ticks it")
expectEqual(reached(0, [true, true, false, false, false]), 1, "two steps done at once: jump past both")
expectEqual(reached(1, [true, false, true, false, false]), nil, "a passing mode on a later step jumps nowhere while a lasting step before it is undone")
expectEqual(reached(1, [true, true, false, true, false]), 3, "a passing step left again is passed over on a skip ahead")
expectEqual(reached(2, [true, true, false, true, true]), 4, "on a passing step, a later lasting step done jumps to the end")
expectEqual(reached(0, [false, true, false, false, false]), nil, "a later step done means nothing while the current lasting step is not")
expectEqual(reached(1, [true, nil, false, true, false]), 3, "a step with no check (or an error) does not stop a skip ahead")
expectEqual(reached(4, [true, true, true, true, true]), 4, "the last step done ends the walk there")
expectEqual(reached(5, [true, true, true, true, true]), nil, "past the end, nothing")
expect(LessonProgress.usableAtPlanTime(false), "a check false at plan time is kept")
expect(!LessonProgress.usableAtPlanTime(true), "a check already true at plan time is rejected")
expect(!LessonProgress.usableAtPlanTime(nil), "a check that errors at plan time is rejected")

// MARK: The donut recipe

let donut = LessonRecipes.match(goal: "make a donut", hook: BlenderHook())
expect(donut != nil, "a donut in Blender uses the built-in recipe")
expect(LessonRecipes.match(goal: "making a doughnut", hook: BlenderHook()) != nil, "doughnut spelling too")
expect(LessonRecipes.match(goal: "make a donut", hook: nil) == nil, "no recipe without the Blender hook")
expect(LessonRecipes.match(goal: "model a mug", hook: BlenderHook()) == nil, "other goals are planned by the model")
if let donut {
    expectEqual(donut.steps.map(\.title).prefix(4), ["Add a torus", "Shape the dough", "Smooth the shape", "Shade smooth"],
                "torus, scale, subdivision, shade smooth")
    expect(donut.steps.allSatisfy { $0.doneCheck != nil }, "every donut step has a check")
    for step in donut.steps {
        expect(step.instruction.count <= 90, "\"\(step.title)\" fits one caption (\(step.instruction.count) chars)")
        expect(!step.instruction.contains("\u{2014}"), "\"\(step.title)\" has no em dash")
    }
    // The user's scene as the recipe's checks would read it, step by step. He adds the torus, scales,
    // then does shade smooth before the subdivision, goes into Edit Mode, selects, separates the icing:
    // each poll lands on the furthest step the scene shows.
    let lasts = donut.steps.map(\.lasting)
    func at(_ current: Int, _ met: [Bool]) -> Int? { LessonProgress.reached(from: current, met: met, lasting: lasts) }
    expectEqual(lasts, [true, true, true, true, false, false, true, false, true], "mode and selection steps pass")
    expectEqual(at(0, [true, false, false, false, false, false, false, false, false]), 0, "torus added: step 1 ticks")
    expectEqual(at(1, [true, true, false, false, false, false, false, false, false]), 1, "scaled: step 2 ticks")
    expectEqual(at(2, [true, true, false, true, false, false, false, false, false]), nil, "shade smooth before the subdivision waits on it")
    expectEqual(at(2, [true, true, true, true, false, false, false, false, false]), 3, "subdivision then too: jump past shade smooth")
    expectEqual(at(4, [true, true, true, true, true, true, false, false, false]), 5, "Tab and a box select at once: steps 5 and 6")
    expectEqual(at(6, [true, true, true, true, false, false, true, false, false]), 6, "icing separated: step 7 ticks once out of Edit Mode too")
    expectEqual(at(4, [true, true, true, true, false, false, true, true, false]), 7, "icing made and selected while on step 5: jump to 9")
    expectEqual(at(7, [true, true, true, true, false, false, true, false, true]), 8, "Solidify on with the dough active: the lesson ends")
}

// MARK: Presenter protocol (--present)

func parsed(_ line: String) -> PresenterCommand? { if case .success(let c) = PresenterCommand.parse(line) { return c } else { return nil } }
func parseError(_ line: String) -> String? { if case .failure(let e) = PresenterCommand.parse(line) { return e.message } else { return nil } }

expectEqual(parsed(#"{"op":"assistant","id":"astra"}"#), .assistant(id: "astra"), "assistant op")
expectEqual(parsed(#"{"op":"point","id":7,"rect":{"x":1480,"y":672,"w":48,"h":48},"caption":"Click Equals","speak":"Here","step":2,"of":3}"#),
            .point(id: 7, rect: CGRect(x: 1480, y: 672, width: 48, height: 48), caption: "Click Equals", speak: "Here", step: 2, of: 3), "point with every field")
expectEqual(parsed(#"{"op":"point","id":1,"rect":{"x":0.5,"y":-20,"w":10,"h":12.5},"caption":"Here"}"#),
            .point(id: 1, rect: CGRect(x: 0.5, y: -20, width: 10, height: 12.5), caption: "Here", speak: nil, step: nil, of: nil), "point: decimals, negative origin, no speech or step")
expectEqual(parsed(#"{"op":"click","id":8,"x":120,"y":340.5,"caption":"Pressing 7"}"#), .click(id: 8, x: 120, y: 340.5, caption: "Pressing 7"), "click op")
expectEqual(parsed(#"{"op":"caption","id":9,"text":"Opening it","speak":true}"#), .caption(id: 9, text: "Opening it", speak: true), "caption op")
expectEqual(parsed(#"{"op":"caption","id":9,"text":"Opening it"}"#), .caption(id: 9, text: "Opening it", speak: false), "caption speaks only when asked")
expectEqual(parsed(#"{"op":"hide"}"#), .hide, "hide op")
expectEqual(parsed(#"{"op":"quit"}"#), .quit, "quit op")

expectEqual(parseError("not json"), "not a JSON object", "garbage is an error")
expectEqual(parseError("[1,2]"), "not a JSON object", "a JSON array is an error")
expectEqual(parseError(#"{"id":1}"#), "missing op", "no op is an error")
expectEqual(parseError(#"{"op":"dance"}"#), "unknown op \"dance\"", "unknown op is an error")
expectEqual(parseError(#"{"op":"assistant"}"#), "assistant: missing id", "assistant needs an id")
expectEqual(parseError(#"{"op":"point","rect":{"x":1,"y":2,"w":3,"h":4}}"#), "point: missing id", "point needs an op id")
expectEqual(parseError(#"{"op":"point","id":1}"#), "point: missing rect", "point needs a rect")
expectEqual(parseError(#"{"op":"point","id":1,"rect":{"x":1,"y":2,"w":3}}"#), "point rect: missing h", "point rect needs all four fields")
expectEqual(parseError(#"{"op":"point","id":1,"rect":{"x":1,"y":2,"w":-3,"h":4}}"#), "point rect: w and h must not be negative", "negative size is an error")
expectEqual(parseError(#"{"op":"point","id":"7","rect":{"x":1,"y":2,"w":3,"h":4}}"#), "point: id must be a number", "id must be a number")
expectEqual(parseError(#"{"op":"point","id":1.5,"rect":{"x":1,"y":2,"w":3,"h":4}}"#), "point: id must be an integer", "id must be a whole number")
expectEqual(parseError(#"{"op":"click","id":8,"x":1}"#), "click: missing y", "click needs x and y")
expectEqual(parseError(#"{"op":"click","id":8,"x":true,"y":2}"#), "click: x must be a number", "a boolean is not a coordinate")
expectEqual(parseError(#"{"op":"caption","id":9}"#), "caption: missing text", "caption needs text")
expectEqual(parseError(#"{"op":"caption","id":9,"text":"x","speak":"yes"}"#), "caption: speak must be true or false", "speak must be a boolean")
expectEqual(PresenterEvent.ready.line, #"{"ev":"ready"}"#, "ready event line")
expectEqual(PresenterEvent.landed(id: 7).line, #"{"ev":"landed","id":7}"#, "landed event line")
expectEqual(PresenterEvent.spoken(id: 3).line, #"{"ev":"spoken","id":3}"#, "spoken event line")
expectEqual(PresenterEvent.esc.line, #"{"ev":"esc"}"#, "esc event line")
expectEqual(PresenterEvent.error("bad \"x\"").line, #"{"ev":"error","message":"bad \"x\""}"#, "error event line escapes the message")

// MARK: PlanTrust (async: the store is a real JSON file in the scratch dir)

func plan(_ question: String, bundle: String = "org.blenderfoundation.blender", chore: Bool) -> CachedPlan {
    var phase = CachedPhase(say: "Here's Bevel")
    if chore { phase.actions = [CachedAction(kind: "blender_python", description: "Switch to Edit Mode", code: "bpy.ops.object.mode_set(mode='EDIT')")] }
    return CachedPlan(question: PlanCache.normalize(question), bundleID: bundle, version: "4.5", fingerprint: "blender:OBJECT|MESH",
                      phases: [phase], savedAt: Date(), hits: 0)
}

func sleep(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1e9)) }

Task { @MainActor in
    let trust = PlanTrust()
    trust.settle = 0.05
    trust.pollEvery = 0.02
    nonisolated(unsafe) var pill = false
    trust.undoShowing = { pill }

    // A plan that only points is saved straight away.
    await trust.schedule("k-point", plan("where is the bevel tool", chore: false)).value
    expect(PlanCache.lookup("k-point") != nil, "a pointing-only plan is saved at once")

    // A plan that did a chore waits for its Undo pill; pressing Undo means it is never saved.
    pill = true
    let undone = trust.schedule("k-undone", plan("bevel prep", chore: true))
    await sleep(0.15)
    expect(PlanCache.lookup("k-undone") == nil, "a chore plan is not saved while its Undo pill shows")
    trust.undone()
    pill = false
    await undone.value
    expect(PlanCache.lookup("k-undone") == nil, "Undo means the plan is never saved")

    // The pill going away unpressed is what earns the save.
    pill = true
    let kept = trust.schedule("k-kept", plan("bevel prep", chore: true))
    await sleep(0.1)
    pill = false
    await kept.value
    expect(PlanCache.lookup("k-kept") != nil, "a chore plan is saved once its Undo pill went away unpressed")

    // Undo after a replay deletes that entry; after a new ask it no longer does.
    trust.replayed("k-kept")
    trust.undone()
    expect(PlanCache.lookup("k-kept") == nil, "Undo after a replay deletes the replayed entry")
    trust.replayed("k-point")
    trust.newAsk()
    trust.undone()
    expect(PlanCache.lookup("k-point") != nil, "Undo after a new ask leaves the earlier replay alone")

    // --forget removes a question in every app and context, nothing else.
    PlanCache.save("k-other-app", plan("Where's the bevel tool?", bundle: "com.other", chore: false))
    expectEqual(PlanCache.forget("where is the bevel tool"), 2, "forget removes the question everywhere")
    expect(PlanCache.lookup("k-point") == nil && PlanCache.lookup("k-other-app") == nil, "both entries are gone")
    PlanCache.save("k-keep", plan("where is loop cut", chore: false))
    expectEqual(PlanCache.forget("where is the bevel tool"), 0, "forget again finds nothing")
    expect(PlanCache.lookup("k-keep") != nil, "other questions survive a forget")

    try? FileManager.default.removeItem(at: scratch)
    for failure in failed { print("FAIL \(failure)") }
    print("\(passed) passed, \(failed.count) failed")
    exit(failed.isEmpty ? 0 : 1)
}
dispatchMain()
