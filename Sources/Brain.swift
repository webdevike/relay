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
    var calls: [String] = []
    var finished = false
    var latency: TimeInterval = 0

    var summary: String {
        String(format: "%.2fs model, calls: %@", latency, calls.joined(separator: " | "))
    }
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

/// Asks the model where to point, through the OpenAI Responses API with four function tools.
final class Brain {
    let model = ProcessInfo.processInfo.environment["RELAY_BUDDY_MODEL"] ?? "gpt-6.1-terra"
    private let effort = ProcessInfo.processInfo.environment["RELAY_BUDDY_EFFORT"] ?? "low"
    private let endpoint = URL(string: "https://api.openai.com/v1/responses")!

    private static let instructions = """
    You are Buddy, a friendly helper that lives next to the user's cursor inside Relay. The user is \
    learning the app in the screenshot and asked a question about it. Show them where to go: you point \
    on their screen; you never click for them.

    Answer with tool calls only, all of them together in ONE turn as parallel calls, in this order:
    - say(text): one short caption shown next to your cursor. At most 90 characters, plain and friendly, \
    telling the user what to do there, e.g. "Click Bevel, then drag to size it". Never use em dashes.
    - point(x, y, label): put your cursor on one exact spot, the center of a button, icon, menu or field. \
    label names it in 1 to 4 words.
    - highlight(rect, label): outline a larger region instead, such as a panel, a menu or a group of controls.
    - done(): last.

    Rules:
    - Coordinates are pixels of the screenshot: origin at its top-left corner, x to the right, y down.
    - When an accessibility element matches the target, aim at the center of its frame.
    - Many apps draw icon-only toolbars with no accessibility labels. Look at the screenshot closely and \
    aim at the exact icon.
    - Every answer about the screen MUST include at least one point or highlight call; a caption alone \
    is not enough. If the exact target is hidden (another mode, tab, menu or panel), point at the \
    visible control that gets the user there (for example a mode dropdown) and say the steps, \
    including the keyboard shortcut when there is one.
    - Usually one point or highlight. Use up to three, in order, only when the path needs several steps.
    - If the question has nothing to do with the screen, just say a short answer, then done.
    """

    private static let tools: [[String: Any]] = [
        function("say", "Show one short caption line next to Buddy's cursor.",
                 ["text": ["type": "string", "description": "At most 90 characters."]]),
        function("point", "Move Buddy's cursor to one exact spot in the screenshot and pulse a ring there.", [
            "x": ["type": "number", "description": "Screenshot pixel x."],
            "y": ["type": "number", "description": "Screenshot pixel y."],
            "label": ["type": "string", "description": "What is there, 1 to 4 words."],
        ]),
        function("highlight", "Outline a rectangular region of the screenshot.", [
            "rect": [
                "type": "object",
                "properties": [
                    "x": ["type": "number"], "y": ["type": "number"],
                    "width": ["type": "number"], "height": ["type": "number"],
                ],
                "required": ["x", "y", "width", "height"],
                "additionalProperties": false,
            ],
            "label": ["type": "string", "description": "What the region is, 1 to 4 words."],
        ]),
        function("done", "Finish the answer.", [:]),
    ]

    private static func function(_ name: String, _ description: String, _ properties: [String: Any]) -> [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": description,
            "strict": true,
            "parameters": [
                "type": "object",
                "properties": properties,
                "required": Array(properties.keys),
                "additionalProperties": false,
            ] as [String: Any],
        ]
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

    func plan(question: String, context: ScreenContext) async throws -> Plan {
        guard let key = apiKey else { throw BrainError.noKey }
        let width = Int(context.imageSize.width)
        let height = Int(context.imageSize.height)
        let elements = context.axLines.isEmpty
            ? "(none: this app draws its own UI, so rely on the screenshot)"
            : context.axLines.joined(separator: "\n")
        let userText = """
        App: \(context.target.name) (\(context.target.bundleID))
        Window: "\(context.windowTitle)"
        Screenshot: \(width)x\(height) pixels. Coordinates use this pixel space.
        Accessibility elements, role "label" [x,y,width,height]:
        \(elements)

        Question: \(question)
        """
        var input: [[String: Any]] = [[
            "role": "user",
            "content": [
                ["type": "input_text", "text": userText],
                ["type": "input_image", "detail": "original",
                 "image_url": "data:image/jpeg;base64," + context.jpeg.base64EncodedString()],
            ],
        ]]
        var plan = Plan()
        let started = Date()
        // Normally one turn carries say + point + done in parallel. If the model stops early
        // (a caption but nothing to point at, and no done), acknowledge its calls and let it go on.
        for _ in 0..<3 {
            let json = try await send(input: input, key: key)
            DebugDump.save(context: context, question: question, userText: userText,
                           response: (try? JSONSerialization.data(withJSONObject: json, options: .prettyPrinted)) ?? Data())
            let output = (json["output"] as? [[String: Any]]) ?? []
            let callIDs = Brain.parse(output, into: &plan)
            if plan.finished || !plan.steps.isEmpty || callIDs.isEmpty { break }
            input += output
            input += callIDs.map { ["type": "function_call_output", "call_id": $0, "output": "shown"] }
        }
        plan.latency = Date().timeIntervalSince(started)
        return plan
    }

    private func send(input: [[String: Any]], key: String) async throws -> [String: Any] {
        let body: [String: Any] = [
            "model": model,
            "instructions": Brain.instructions,
            "input": input,
            "tools": Brain.tools,
            "tool_choice": "required",
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

    private static func number(_ value: Any?) -> CGFloat? {
        (value as? NSNumber).map { CGFloat(truncating: $0) }
    }
}

/// Last request and response on disk for debugging: ~/Library/Caches/RelayBuddy/last/.
enum DebugDump {
    static let directory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Caches/RelayBuddy/last")

    static func save(context: ScreenContext, question: String, userText: String, response: Data) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? context.jpeg.write(to: directory.appendingPathComponent("screenshot.jpg"))
        try? userText.write(to: directory.appendingPathComponent("prompt.txt"), atomically: true, encoding: .utf8)
        try? response.write(to: directory.appendingPathComponent("response.json"))
        let meta = String(format: "question: %@\nwindowFrame: %@\nscale: %.4f\nbackend: %@\n",
                          question, NSStringFromRect(context.windowFrame), context.scale, context.backend)
        try? meta.write(to: directory.appendingPathComponent("meta.txt"), atomically: true, encoding: .utf8)
    }
}
