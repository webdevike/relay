import Cocoa

/// Multi-screen navigation ("take me to Bluetooth settings", "go to Downloads in Finder"): runs
/// the same Jev loop as computer_do (.omp/tools/jev-nav.ts) instead of one Terra call per screen.
/// The script AX-presses each control and streams one JSON line per press; Buddy glides to it.
enum Navigator {
    /// RELAY_BUDDY_NAV=terra turns the Jev paths off (before/after timing, debugging).
    static var enabled: Bool { ProcessInfo.processInfo.environment["RELAY_BUDDY_NAV"] != "terra" }

    private static let script = ProcessInfo.processInfo.environment["RELAY_BUDDY_NAV_SCRIPT"]
        ?? "/Users/ike/Eva/.omp/tools/jev-nav.ts"
    static let bun = ProcessInfo.processInfo.environment["RELAY_BUDDY_BUN"] ?? "/Users/ike/.bun/bin/bun"
    static let maxSteps = 6

    private static let pattern = try! NSRegularExpression(
        pattern: #"^\s*(?:please )?(?:take me to|bring me to|go to|head to|jump to|navigate to|switch to|open up|open|show me)\s+\S"#,
        options: .caseInsensitive)

    /// "take me to X", "open X", "go to X": ask to arrive at a screen, not to point at a control.
    static func isNavigation(_ question: String) -> Bool {
        let range = NSRange(location: 0, length: (question as NSString).length)
        guard pattern.firstMatch(in: question, range: range) != nil else { return false }
        return question.range(of: #"\b(how|why|what)\b"#, options: [.regularExpression, .caseInsensitive]) == nil
    }

    /// Apps whose AX tree cannot drive navigation (their own hooks or canvases handle them).
    static func skips(_ target: TargetApp) -> Bool {
        target.bundleID.lowercased().contains("blender") || target.name.lowercased().contains("blender")
    }

    struct Step {
        let label: String
        /// Global display points, top-left origin.
        let frame: CGRect
        let jevMs: Int
        let pressMs: Int
    }

    struct Result {
        var steps: [Step] = []
        var final = "error"
        var totalMs = 0
        var reason = ""
    }

    /// Runs the script, calling `onStep` on the main actor as each press lands.
    static func run(goal: String, target: TargetApp, windowID: CGWindowID, onStep: @escaping @MainActor (Step) -> Void) async -> Result {
        await withCheckedContinuation { (continuation: CheckedContinuation<Result, Never>) in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: bun)
            process.arguments = [script, "--pid", String(target.pid), "--window", String(windowID), "--goal", goal, "--app", target.name, "--max", String(maxSteps)]
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "/Users/ike/.bun/bin:/Users/ike/.local/bin:/Applications/CuaDriver.app/Contents/MacOS:" + (env["PATH"] ?? "/usr/bin:/bin")
            process.environment = env
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice
            var result = Result()
            do { try process.run() } catch {
                result.reason = error.localizedDescription
                return continuation.resume(returning: result)
            }
            DispatchQueue.global(qos: .userInitiated).async {
                var buffer = Data()
                while true {
                    let chunk = pipe.fileHandleForReading.availableData
                    if chunk.isEmpty { break }
                    buffer.append(chunk)
                    while let newline = buffer.firstIndex(of: 0x0A) {
                        let line = buffer.subdata(in: buffer.startIndex..<newline)
                        buffer.removeSubrange(buffer.startIndex...newline)
                        guard let json = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                        if let final = json["final"] as? String {
                            result.final = final
                            result.totalMs = json["total_ms"] as? Int ?? 0
                            result.reason = json["reason"] as? String ?? ""
                        } else if let label = json["label"] as? String, let f = json["frame"] as? [String: Double] {
                            let step = Step(label: label, frame: CGRect(x: f["x"] ?? 0, y: f["y"] ?? 0, width: f["w"] ?? 0, height: f["h"] ?? 0),
                                            jevMs: json["jev_ms"] as? Int ?? 0, pressMs: json["press_ms"] as? Int ?? 0)
                            result.steps.append(step)
                            Task { @MainActor in onStep(step) }
                        }
                    }
                }
                process.waitUntilExit()
                continuation.resume(returning: result)
            }
        }
    }

    /// A context whose "screenshot pixels" are global display points, so the overlay can be
    /// pointed at AX frames straight from cua-driver.
    static func globalContext(for target: TargetApp, windowID: CGWindowID) -> ScreenContext {
        ScreenContext(target: target, windowTitle: "", windowFrame: .zero, windowID: windowID, jpeg: Data(),
                      imageSize: .zero, scale: 1, axLines: [], backend: "jev-nav")
    }
}
