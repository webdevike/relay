import Foundation

// Behaviour tests for the rules Relay Assist decides by itself, without a model or the screen:
// who answers (AssistantRouter), the no-brain asks (Shortcut, Capabilities, Handoff), when a plan
// earns or loses its cache entry (PlanTrust), and how lesson checks tick steps off (LessonGate).
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

// MARK: LessonGate

func run(_ results: [Bool?]) -> [LessonGate.Outcome] {
    var gate = LessonGate()
    return results.map { gate.observe($0).0 }
}
expectEqual(run([false, false, true]), [.waiting, .waiting, .done], "a check ticks its step once it turns true")
expectEqual(run([true]), [.alreadyTrue], "a check already true at step start never ticks the step off")
expectEqual(run([nil, nil]), [.waiting, .waiting], "an erroring check is never done")
expectEqual(run([false, nil, true]), [.waiting, .waiting, .done], "an error in between does not block a later true")
// Step 1 "add a torus" also left it smooth, so step 2's "shade smooth" check is already true when step 2 starts:
// step 2 waits for "next" instead of ticking off the moment step 1 does.
expectEqual(run([false, true]) + run([true]), [.waiting, .done, .alreadyTrue], "steps finish one at a time, in order")
var gate = LessonGate()
expectEqual(gate.observe(false).changed, true, "the first result is logged")
expectEqual(gate.observe(false).changed, false, "a repeat is not logged")
expectEqual(gate.observe(true).changed, true, "a change is logged")
expect(LessonGate.usableAtPlanTime(false), "a check false at plan time is kept")
expect(!LessonGate.usableAtPlanTime(true), "a check already true at plan time is rejected")
expect(!LessonGate.usableAtPlanTime(nil), "a check that errors at plan time is rejected")
expectEqual(LessonController.goal(in: "Teach me how to add a torus."), "add a torus", "teach me how to")
expectEqual(LessonController.goal(in: "lesson: bevel the cube"), "bevel the cube", "lesson:")
expect(LessonController.goal(in: "where is the bevel tool") == nil, "a question is not a lesson")

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
