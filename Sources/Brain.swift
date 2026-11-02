import Foundation

/// One thing to show, in screenshot pixel space.
struct PlanStep {
    enum Kind {
        case point(CGPoint)
        case highlight(CGRect)
    }
    let kind: Kind
    let label: String
}

struct Plan {
    var steps: [PlanStep] = []
    var say: String?
    var doRequest: DoRequest?
    var calls: [String] = []
    var finished = false
    var latency: TimeInterval = 0

    var summary: String {
        String(format: "%.2fs model, calls: %@", latency, calls.joined(separator: " | "))
    }
}

/// One step of a lesson ("teach me to ...").
struct LessonStep {
    let title: String
    let instruction: String
    /// App-hook expression that turns true once the user finished the step (Blender: Python).
    let doneCheck: String?
}

/// What Buddy knows about the moment of the question, beyond the screenshot.
struct AskContext {
    var sceneState: String?
    var hookName: String?
    var hookNotes: String?
    var userAskedToDo = false
    /// Extra situation for the model, e.g. a chore Buddy just did or the current lesson step.
    var note: String?
}

enum BrainError: LocalizedError {
    case noKey
    case http(Int, String)
    case badResponse(String)

    var errorDescription: String? {
        switch self {
        case .noKey: return "No OpenAI key found (OPENAI_API_KEY)."
        case .http(let code, let message): return "The model call failed (\(code)): \(message)"
        case .badResponse(let why): return "I got an answer I couldn't read: \(why)"
        }
    }
}

/// Asks the model where to point and what chores to do, through the OpenAI Responses API.
final class Brain {
    let model = ProcessInfo.processInfo.environment["RELAY_BUDDY_MODEL"] ?? "gpt-6.1-terra"
    private let effort = ProcessInfo.processInfo.environment["RELAY_BUDDY_EFFORT"] ?? "low"
    private let endpoint = URL(string: "https://api.openai.com/v1/responses")!

    private static let instructions = """
    You are Buddy, a friendly helper that lives next to the user's cursor inside Relay. The user is \
    learning the app in the screenshot and asked a question about it. Show them where to go: you point \
    on their screen. You may do small chores for them, but the user does the thing they are learning.

    Answer with tool calls only, all of them together in ONE turn as parallel calls, in this order:
    - say(text): one short caption shown next to your cursor. At most 90 characters, plain and friendly, \
    telling the user what to do there, e.g. "Click Bevel, then drag to size it". Never use em dashes.
    - point(x, y, label): put your cursor on one exact spot, the center of a button, icon, menu or field. \
    label names it in 1 to 4 words.
    - highlight(rect, label): outline a larger region instead, such as a panel, a menu or a group of controls.
    - do(announce, core_step, actions): act in the app for the user (see below).
    - done(): last.

    Rules for pointing:
    - Coordinates are pixels of the screenshot: origin at its top-left corner, x to the right, y down.
    - When an accessibility element matches the target, aim at the center of its frame.
    - Many apps draw icon-only toolbars with no accessibility labels. Look at the screenshot closely and \
    aim at the exact icon.
    - Every answer about the screen MUST include at least one point, highlight or do call.
    - For "how do I X" or "where is X", point at the button, icon or menu item for X (for example the \
    tool's icon in a toolbar), not at the object it acts on, and mention the shortcut in say().
    - Usually one point or highlight. Use up to three, in order, only when the path needs several steps.
    - If the question has nothing to do with the screen, just say a short answer, then done.

    Rules for do():
    - A chore is a step on the way that is not the thing being learned: switching a mode, opening a \
    menu, panel or tab, closing a popup. When the target is hidden behind a chore, do the chore with \
    core_step false instead of only describing it. Then do NOT point at the hidden target in this turn: \
    you get a fresh screenshot after the chore and point then. say() should describe the next step.
    - The core step is the thing the user asked to learn (asked "how do I bevel": beveling is core). \
    Only do a core step when the prompt says "User asked Buddy to do it: yes"; then set core_step true \
    and include any chores it needs in the same actions list. Otherwise teach it by pointing.
    - announce is past tense and short, e.g. "Switched to Edit Mode for you" or "Beveled the edges".
    - Each action: kind, description (3 to 6 words), x and y (screenshot pixels of where the action \
    happens: the control it uses, e.g. a mode dropdown, or the object it changes, e.g. the cube; Buddy \
    moves there so the user sees what changed; null only if nothing on screen fits), and the fields its kind needs: \
    blender_python needs code; click needs x and y; key needs keys, e.g. ["cmd","1"] or ["escape"]; \
    menu needs menu_path, e.g. ["View","Show Sidebar"]. Unused fields are null.
    - Never do anything destructive or irreversible: no deleting, sending, saving, buying or quitting.
    """

    private static let lessonInstructions = """
    You are Buddy, a friendly helper next to the user's cursor. The user wants to be taught a goal in \
    the app in the screenshot. Plan it as 2 to 5 small steps the user does themselves, in order, \
    starting from the current state. When the user lists the steps, use exactly those, in their \
    order, and add nothing. Call lesson() once.
    - title: 2 to 5 words. instruction: what to do, at most 90 characters, include the shortcut when \
    there is one. Never use em dashes.
    - done_check: when the prompt has live app state from a hook, a Python expression that becomes \
    True once the user has finished that step and is False now. Names available: bpy, obj (the \
    active object or None), scene, mode (bpy.context.mode, e.g. 'OBJECT', 'EDIT_MESH'). Keep it \
    robust, e.g. "obj is not None and obj.name.startswith('Torus')" or \
    "obj is not None and all(p.use_smooth for p in obj.data.polygons)". Use null when there is no hook.
    """

    private static let nullableNumber: [String: Any] = ["type": ["number", "null"]]
    private static let nullableString: [String: Any] = ["type": ["string", "null"]]
    private static let nullableStrings: [String: Any] = ["type": ["array", "null"], "items": ["type": "string"]]

    private static let tools: [[String: Any]] = [
        function("say", "Show one short caption line next to Buddy's cursor.",
                 ["text": ["type": "string", "description": "At most 90 characters."]]),
        function("point", "Move Buddy's cursor to one exact spot in the screenshot and pulse a ring there.", [
            "x": ["type": "number", "description": "Screenshot pixel x."],
            "y": ["type": "number", "description": "Screenshot pixel y."],
            "label": ["type": "string", "description": "What is there, 1 to 4 words."],
        ]),
        function("highlight", "Outline a rectangular region of the screenshot.", [
            "rect": strictObject([
                "x": ["type": "number"], "y": ["type": "number"],
                "width": ["type": "number"], "height": ["type": "number"],
            ]),
            "label": ["type": "string", "description": "What the region is, 1 to 4 words."],
        ]),
        function("do", "Act in the app for the user: chores, or the core step when they asked for it.", [
            "announce": ["type": "string", "description": "Past tense, e.g. 'Switched to Edit Mode for you'."],
            "core_step": ["type": "boolean", "description": "True only when this is the step being learned."],
            "actions": [
                "type": "array",
                "items": strictObject([
                    "kind": ["type": "string", "enum": ["blender_python", "click", "key", "menu"]],
                    "description": ["type": "string"],
                    "x": nullableNumber, "y": nullableNumber,
                    "code": nullableString,
                    "keys": nullableStrings,
                    "menu_path": nullableStrings,
                ]),
            ] as [String: Any],
        ]),
        function("done", "Finish the answer.", [:]),
    ]

    private static let lessonTool: [String: Any] = function("lesson", "The lesson plan.", [
        "goal": ["type": "string", "description": "The goal in 2 to 6 words."],
        "steps": [
            "type": "array",
            "items": strictObject([
                "title": ["type": "string"],
                "instruction": ["type": "string"],
                "done_check": nullableString,
            ]),
        ] as [String: Any],
    ])

    private static func strictObject(_ properties: [String: Any]) -> [String: Any] {
        ["type": "object", "properties": properties, "required": Array(properties.keys), "additionalProperties": false]
    }

    private static func function(_ name: String, _ description: String, _ properties: [String: Any]) -> [String: Any] {
        ["type": "function", "name": name, "description": description, "strict": true,
         "parameters": strictObject(properties)]
    }

    private lazy var apiKey: String? = {
        if let key = ProcessInfo.processInfo.environment["OPENAI_API_KEY"], !key.isEmpty { return key }
        let path = ProcessInfo.processInfo.environment["RELAY_BUDDY_ENV_FILE"] ?? "/Users/ike/Eva/secrets/openai.env"
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        for raw in text.split(separator: "\n") {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("export ") { line = String(line.dropFirst(7)) }
            guard line.hasPrefix("OPENAI_API_KEY=") else { continue }
            return line.dropFirst("OPENAI_API_KEY=".count).trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
        }
        return nil
    }()

    private func promptText(_ question: String, context: ScreenContext, ask: AskContext) -> String {
        let elements = context.axLines.isEmpty
            ? "(none: this app draws its own UI, so rely on the screenshot)"
            : context.axLines.joined(separator: "\n")
        var text = """
        App: \(context.target.name) (\(context.target.bundleID))
        Window: "\(context.windowTitle)"
        Screenshot: \(Int(context.imageSize.width))x\(Int(context.imageSize.height)) pixels. Coordinates use this pixel space.
        Accessibility elements, role "label" [x,y,width,height]:
        \(elements)

        """
        if let state = ask.sceneState, !state.isEmpty {
            text += "Live app state from the \(ask.hookName ?? "app") hook:\n\(state)\n\n"
        }
        if let notes = ask.hookNotes { text += notes + "\n\n" }
        text += "User asked Buddy to do it: \(ask.userAskedToDo ? "yes" : "no")\n"
        if let note = ask.note { text += note + "\n" }
        text += "\nQuestion: \(question)"
        return text
    }

    private func userInput(_ text: String, _ context: ScreenContext) -> [[String: Any]] {
        [[
            "role": "user",
            "content": [
                ["type": "input_text", "text": text],
                ["type": "input_image", "detail": "original",
                 "image_url": "data:image/jpeg;base64," + context.jpeg.base64EncodedString()],
            ],
        ]]
    }

    func plan(question: String, context: ScreenContext, ask: AskContext) async throws -> Plan {
        guard let key = apiKey else { throw BrainError.noKey }
        let userText = promptText(question, context: context, ask: ask)
        var input = userInput(userText, context)
        var plan = Plan()
        let started = Date()
        // Normally one turn carries say + point/do + done in parallel. If the model stops early
        // (a caption but nothing to point at or do, and no done), acknowledge and let it go on.
        for _ in 0..<3 {
            let json = try await send(input: input, key: key, instructions: Brain.instructions,
                                      tools: Brain.tools, toolChoice: "required")
            DebugDump.save(context: context, question: question, userText: userText, response: json)
            let output = (json["output"] as? [[String: Any]]) ?? []
            let callIDs = Brain.parse(output, into: &plan)
            if plan.finished || !plan.steps.isEmpty || plan.doRequest != nil || callIDs.isEmpty { break }
            input += output
            input += callIDs.map { ["type": "function_call_output", "call_id": $0, "output": "shown"] }
        }
        plan.latency = Date().timeIntervalSince(started)
        return plan
    }

    func planLesson(goal: String, context: ScreenContext, ask: AskContext) async throws -> (String, [LessonStep]) {
        guard let key = apiKey else { throw BrainError.noKey }
        let userText = promptText("Teach me to \(goal)", context: context, ask: ask)
        let json = try await send(input: userInput(userText, context), key: key, instructions: Brain.lessonInstructions,
                                  tools: [Brain.lessonTool], toolChoice: ["type": "function", "name": "lesson"])
        DebugDump.save(context: context, question: "lesson: " + goal, userText: userText, response: json)
        for item in (json["output"] as? [[String: Any]]) ?? [] where item["type"] as? String == "function_call" {
            let args = (try? JSONSerialization.jsonObject(with: Data((item["arguments"] as? String ?? "{}").utf8))) as? [String: Any] ?? [:]
            let steps = ((args["steps"] as? [[String: Any]]) ?? []).compactMap { s -> LessonStep? in
                guard let title = s["title"] as? String, let instruction = s["instruction"] as? String else { return nil }
                return LessonStep(title: title, instruction: instruction, doneCheck: s["done_check"] as? String)
            }
            if !steps.isEmpty { return ((args["goal"] as? String) ?? goal, Array(steps.prefix(6))) }
        }
        throw BrainError.badResponse("no lesson steps")
    }

    private func send(input: [[String: Any]], key: String, instructions: String,
                      tools: [[String: Any]], toolChoice: Any) async throws -> [String: Any] {
        let body: [String: Any] = [
            "model": model,
            "instructions": instructions,
            "input": input,
            "tools": tools,
            "tool_choice": toolChoice,
            "parallel_tool_calls": true,
            "reasoning": ["effort": effort],
            "store": false,
            "include": ["reasoning.encrypted_content"],
        ]
        var request = URLRequest(url: endpoint, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200, let json else {
            let message = ((json?["error"] as? [String: Any])?["message"] as? String)
                ?? String(decoding: data.prefix(200), as: UTF8.self)
            throw BrainError.http(status, message)
        }
        return json
    }

    /// Folds one turn's output into `plan`; returns the call ids to acknowledge.
    static func parse(_ output: [[String: Any]], into plan: inout Plan) -> [String] {
        var callIDs: [String] = []
        var messageText = ""
        for item in output {
            switch item["type"] as? String {
            case "function_call":
                let name = item["name"] as? String ?? ""
                let argText = item["arguments"] as? String ?? "{}"
                if let id = item["call_id"] as? String { callIDs.append(id) }
                plan.calls.append("\(name)\(argText)")
                let args = (try? JSONSerialization.jsonObject(with: Data(argText.utf8))) as? [String: Any] ?? [:]
                let label = (args["label"] as? String) ?? ""
                switch name {
                case "say":
                    if let text = args["text"] as? String, !text.isEmpty { plan.say = plan.say.map { $0 + " " + text } ?? text }
                case "point":
                    if let x = number(args["x"]), let y = number(args["y"]) {
                        plan.steps.append(PlanStep(kind: .point(CGPoint(x: x, y: y)), label: label))
                    }
                case "highlight":
                    if let r = args["rect"] as? [String: Any], let x = number(r["x"]), let y = number(r["y"]),
                       let w = number(r["width"]), let h = number(r["height"]), w > 0, h > 0 {
                        plan.steps.append(PlanStep(kind: .highlight(CGRect(x: x, y: y, width: w, height: h)), label: label))
                    }
                case "do":
                    let actions = ((args["actions"] as? [[String: Any]]) ?? []).compactMap(action)
                    if !actions.isEmpty {
                        plan.doRequest = DoRequest(announce: args["announce"] as? String ?? "Done",
                                                   coreStep: args["core_step"] as? Bool ?? true,
                                                   actions: actions)
                    }
                case "done":
                    plan.finished = true
                default:
                    break
                }
            case "message":
                for part in (item["content"] as? [[String: Any]]) ?? [] {
                    if let text = part["text"] as? String { messageText += text }
                }
            default:
                break
            }
        }
        if plan.say == nil, !messageText.isEmpty { plan.say = messageText }
        return callIDs
    }

    private static func action(_ a: [String: Any]) -> BuddyAction? {
        guard let kind = BuddyAction.Kind(rawValue: a["kind"] as? String ?? "") else { return nil }
        var point: CGPoint?
        if let x = number(a["x"]), let y = number(a["y"]) { point = CGPoint(x: x, y: y) }
        return BuddyAction(kind: kind, description: a["description"] as? String ?? kind.rawValue, point: point,
                           code: a["code"] as? String, keys: a["keys"] as? [String], menuPath: a["menu_path"] as? [String])
    }

    private static func number(_ value: Any?) -> CGFloat? {
        (value as? NSNumber).map { CGFloat(truncating: $0) }
    }
}

/// Last request and response on disk for debugging: ~/Library/Caches/RelayBuddy/last/.
enum DebugDump {
    static let directory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Caches/RelayBuddy/last")

    static func save(context: ScreenContext, question: String, userText: String, response: [String: Any]) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? context.jpeg.write(to: directory.appendingPathComponent("screenshot.jpg"))
        try? userText.write(to: directory.appendingPathComponent("prompt.txt"), atomically: true, encoding: .utf8)
        let data = (try? JSONSerialization.data(withJSONObject: response, options: .prettyPrinted)) ?? Data()
        try? data.write(to: directory.appendingPathComponent("response.json"))
        let meta = String(format: "question: %@\nwindowFrame: %@\nscale: %.4f\nbackend: %@\n",
                          question, NSStringFromRect(context.windowFrame), context.scale, context.backend)
        try? meta.write(to: directory.appendingPathComponent("meta.txt"), atomically: true, encoding: .utf8)
    }
}
