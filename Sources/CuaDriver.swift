import Cocoa

/// Capture through the already-authorized cua-driver daemon (com.trycua.driver holds
/// Accessibility + Screen Recording), so Relay Buddy works before it has grants of its own.
enum CuaDriver {
    static let executable = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver"
    static let socket = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Caches/cua-driver/cua-driver.sock").path

    static var isAvailable: Bool {
        FileManager.default.isExecutableFile(atPath: executable) && FileManager.default.fileExists(atPath: socket)
    }

    static func capture(_ target: TargetApp) async throws -> ScreenContext {
        // Window ids and bounds from WindowServer need no permission.
        guard let window = Capture.frontWindow(pid: target.pid) else { throw CaptureError.noWindow(target.name) }
        let shotPath = NSTemporaryDirectory() + "relay-buddy-cua-\(UUID().uuidString).png"
        defer { try? FileManager.default.removeItem(atPath: shotPath) }
        let args: [String: Any] = [
            "pid": Int(target.pid),
            "window_id": Int(window.id),
            "max_elements": 400,
            "max_depth": 30,
            "timeout_ms": 1500,
            "max_image_dimension": Int(Capture.maxImageEdge),
            "screenshot_out_file": shotPath,
        ]
        let argJSON = String(data: try JSONSerialization.data(withJSONObject: args), encoding: .utf8)!
        let output = try await run([executable, "call", "get_window_state", argJSON])
        guard let json = try? JSONSerialization.jsonObject(with: output) as? [String: Any] else {
            throw CaptureError.failed("cua-driver: " + String(decoding: output.prefix(300), as: UTF8.self))
        }
        guard let image = NSImage(contentsOfFile: shotPath),
              let rep = image.representations.first,
              let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
              let jpeg = NSBitmapImageRep(cgImage: cgImage).representation(using: .jpeg, properties: [.compressionFactor: 0.85])
        else { throw CaptureError.failed("cua-driver returned no screenshot") }

        var frame = window.frame
        if let b = json["window_bounds"] as? [String: Any],
           let x = b["x"] as? Double, let y = b["y"] as? Double, let w = b["width"] as? Double, let h = b["height"] as? Double {
            frame = CGRect(x: x, y: y, width: w, height: h)
        }
        let pixelWidth = CGFloat(rep.pixelsWide)
        let scale = pixelWidth / frame.width

        // cua-driver element frames are window-local screenshot pixels, the same space we send.
        var lines: [String] = []
        for element in (json["elements"] as? [[String: Any]]) ?? [] {
            guard let f = element["frame"] as? [String: Any],
                  let x = f["x"] as? Double, let y = f["y"] as? Double,
                  let w = f["w"] as? Double, let h = f["h"] as? Double, w >= 2, h >= 2 else { continue }
            let role = (element["role"] as? String ?? "").replacingOccurrences(of: "AX", with: "")
            var label = (element["label"] as? String) ?? (element["value"] as? String) ?? ""
            label = label.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\"", with: "'")
            if label.count > 60 { label = String(label.prefix(57)) + "..." }
            let text = label.isEmpty ? "" : " \"\(label)\""
            lines.append("\(role)\(text) [\(Int(x)),\(Int(y)),\(Int(w)),\(Int(h))]")
            if lines.count >= 220 { break }
        }
        return ScreenContext(
            target: target,
            windowTitle: json["window_title"] as? String ?? window.title,
            windowFrame: frame,
            windowID: window.id,
            jpeg: jpeg,
            imageSize: CGSize(width: cgImage.width, height: cgImage.height),
            scale: scale,
            axLines: lines,
            backend: "cua-driver")
    }

    /// One cua-driver tool call through the daemon; returns its JSON result.
    @discardableResult
    static func call(_ tool: String, _ args: [String: Any]) async throws -> [String: Any] {
        let argJSON = String(data: try JSONSerialization.data(withJSONObject: args), encoding: .utf8)!
        let output = try await run([executable, "call", tool, argJSON])
        guard let json = try? JSONSerialization.jsonObject(with: output) as? [String: Any] else {
            throw CaptureError.failed("cua-driver \(tool): " + String(decoding: output.prefix(300), as: UTF8.self))
        }
        return json
    }

    static func run(_ command: [String]) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: command[0])
                process.arguments = Array(command.dropFirst())
                let pipe = Pipe()
                process.standardOutput = pipe
                process.standardError = FileHandle.nullDevice
                do { try process.run() } catch {
                    return continuation.resume(throwing: CaptureError.failed(error.localizedDescription))
                }
                // Drain before waiting: the JSON can exceed the pipe buffer.
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                continuation.resume(returning: data)
            }
        }
    }
}
