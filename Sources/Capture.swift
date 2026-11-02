import ApplicationServices
import Cocoa
import ScreenCaptureKit

/// What Buddy saw: one window's picture plus its trimmed accessibility tree, both in the
/// screenshot's pixel space (origin top-left of the window, y down).
struct ScreenContext {
    let target: TargetApp
    let windowTitle: String
    /// Window frame in global display points, top-left origin (CoreGraphics space).
    let windowFrame: CGRect
    let windowID: CGWindowID
    let jpeg: Data
    let imageSize: CGSize
    /// Screenshot pixels per display point.
    let scale: CGFloat
    let axLines: [String]
    let backend: String

    /// Screenshot pixel -> global CoreGraphics point.
    func globalPoint(_ p: CGPoint) -> CGPoint {
        CGPoint(x: windowFrame.minX + p.x / scale, y: windowFrame.minY + p.y / scale)
    }

    func globalRect(_ r: CGRect) -> CGRect {
        CGRect(origin: globalPoint(r.origin), size: CGSize(width: r.width / scale, height: r.height / scale))
    }
}

enum CaptureError: LocalizedError {
    case noWindow(String)
    case noPermission
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .noWindow(let app): return "I can't find a window for \(app)."
        case .noPermission: return "I need Screen Recording access, or a running cua-driver, to see the screen."
        case .failed(let why): return "I couldn't see the screen: \(why)"
        }
    }
}

enum Capture {
    static let maxImageEdge: CGFloat = 3840

    /// In-process capture needs this process (or the terminal that launched it) to hold
    /// Screen Recording. Otherwise Buddy borrows cua-driver, which holds its own grants.
    /// RELAY_BUDDY_CAPTURE=cua-driver forces the borrowed path (for testing it).
    static var nativeAvailable: Bool {
        ProcessInfo.processInfo.environment["RELAY_BUDDY_CAPTURE"] != "cua-driver" && CGPreflightScreenCaptureAccess()
    }

    static var backendDescription: String {
        if nativeAvailable { return AXIsProcessTrusted() ? "native (ScreenCaptureKit + AX)" : "native screenshot, AX off" }
        return CuaDriver.isAvailable ? "cua-driver" : "unavailable"
    }

    static func capture(_ target: TargetApp) async throws -> ScreenContext {
        if nativeAvailable { return try await native(target) }
        if CuaDriver.isAvailable { return try await CuaDriver.capture(target) }
        throw CaptureError.noPermission
    }

    // MARK: Window lookup

    struct WindowInfo {
        let id: CGWindowID
        let frame: CGRect
        let title: String
    }

    /// Frontmost normal window of `pid`. CGWindowList is ordered front to back.
    static func frontWindow(pid: pid_t) -> WindowInfo? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] else { return nil }
        for entry in list {
            guard (entry[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid,
                  (entry[kCGWindowLayer as String] as? Int) == 0,
                  let boundsDict = entry[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: boundsDict),
                  frame.width > 80, frame.height > 60,
                  let number = entry[kCGWindowNumber as String] as? Int else { continue }
            if let alpha = entry[kCGWindowAlpha as String] as? Double, alpha < 0.05 { continue }
            return WindowInfo(id: CGWindowID(number), frame: frame, title: entry[kCGWindowName as String] as? String ?? "")
        }
        return nil
    }

    static func backingScale(for cgRect: CGRect) -> CGFloat {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        let center = CGPoint(x: cgRect.midX, y: primaryHeight - cgRect.midY)
        return NSScreen.screens.first(where: { $0.frame.contains(center) })?.backingScaleFactor ?? 2
    }

    // MARK: Native (ScreenCaptureKit + AX)

    private static func native(_ target: TargetApp) async throws -> ScreenContext {
        guard let window = frontWindow(pid: target.pid) else { throw CaptureError.noWindow(target.name) }
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        } catch {
            throw CaptureError.failed(error.localizedDescription)
        }
        guard let scWindow = content.windows.first(where: { $0.windowID == window.id }) else {
            throw CaptureError.noWindow(target.name)
        }
        let frame = scWindow.frame
        var scale = backingScale(for: frame)
        let longEdge = max(frame.width, frame.height) * scale
        if longEdge > maxImageEdge { scale *= maxImageEdge / longEdge }

        let config = SCStreamConfiguration()
        config.width = Int((frame.width * scale).rounded())
        config.height = Int((frame.height * scale).rounded())
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        // The AX walk is synchronous IPC into the target app: run it off the main thread,
        // alongside the screenshot.
        let pixelScale = CGFloat(config.width) / frame.width
        let pid = target.pid
        let axWalk = Task.detached(priority: .userInitiated) {
            AXTree.lines(pid: pid, windowFrame: frame, scale: pixelScale)
        }
        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(desktopIndependentWindow: scWindow), configuration: config)
        } catch {
            throw CaptureError.failed(error.localizedDescription)
        }
        guard let jpeg = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else {
            throw CaptureError.failed("could not encode the screenshot")
        }
        // The capture may round the size; derive the true scale from the pixels we got.
        let actualScale = CGFloat(image.width) / frame.width
        let lines = await axWalk.value
        return ScreenContext(
            target: target,
            windowTitle: scWindow.title ?? window.title,
            windowFrame: frame,
            windowID: window.id,
            jpeg: jpeg,
            imageSize: CGSize(width: image.width, height: image.height),
            scale: actualScale,
            axLines: lines,
            backend: "native")
    }
}

/// Trimmed accessibility tree: labelled or interactive elements with frames, capped in count and time.
enum AXTree {
    private static let interactiveRoles: Set<String> = [
        "AXButton", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton", "AXTextField",
        "AXTextArea", "AXSearchField", "AXComboBox", "AXSlider", "AXIncrementor", "AXLink", "AXTab",
        "AXMenuBarItem", "AXMenuItem", "AXDisclosureTriangle", "AXCell", "AXRow", "AXSegmentedControl",
    ]
    private static let skippedRoles: Set<String> = ["AXUnknown", "AXGrowArea", "AXImage"]

    static func lines(pid: pid_t, windowFrame: CGRect, scale: CGFloat, limit: Int = 220) -> [String] {
        guard AXIsProcessTrusted() else { return [] }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.25)
        let deadline = Date().addingTimeInterval(1.0)
        var out: [String] = []

        func format(_ role: String, _ label: String, _ frame: CGRect, note: String = "") -> String {
            let x = Int(((frame.minX - windowFrame.minX) * scale).rounded())
            let y = Int(((frame.minY - windowFrame.minY) * scale).rounded())
            let w = Int((frame.width * scale).rounded())
            let h = Int((frame.height * scale).rounded())
            let shortRole = role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
            let text = label.isEmpty ? "" : " \"\(label)\""
            return "\(shortRole)\(text) [\(x),\(y),\(w),\(h)]\(note)"
        }

        // App menu bar first: it sits outside the window, so its y values are negative.
        if let menuBar = copy(app, kAXMenuBarAttribute).map({ $0 as! AXUIElement }) {
            for item in children(menuBar).prefix(16) {
                // An app that is not frontmost reports its menu items with empty frames: skip those.
                if let f = frame(item), f.width >= 2, f.height >= 2,
                   let title = string(item, kAXTitleAttribute), !title.isEmpty {
                    out.append(format("AXMenuBarItem", title, f, note: " (menu bar, above the window)"))
                }
            }
        }

        guard let window = matchingWindow(app: app, frame: windowFrame) else { return out }
        var stack: [(AXUIElement, Int)] = [(window, 0)]
        var visited = 0
        while let (element, depth) = stack.popLast(), out.count < limit, visited < 4000, Date() < deadline {
            visited += 1
            let role = string(element, kAXRoleAttribute) ?? ""
            if skippedRoles.contains(role) { continue }
            let elementFrame = frame(element)
            if let f = elementFrame, !f.isEmpty, !f.intersects(windowFrame) { continue } // scrolled away
            if depth > 0, let f = elementFrame, f.width >= 2, f.height >= 2 {
                let label = bestLabel(element)
                if !label.isEmpty || interactiveRoles.contains(role) {
                    out.append(format(role, label, f))
                }
            }
            if depth < 30 {
                for child in children(element).reversed() { stack.append((child, depth + 1)) }
            }
        }
        return out
    }

    private static func matchingWindow(app: AXUIElement, frame target: CGRect) -> AXUIElement? {
        let windows = (copy(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        if let match = windows.first(where: { w in
            guard let f = frame(w) else { return false }
            return abs(f.minX - target.minX) < 8 && abs(f.minY - target.minY) < 8 && abs(f.width - target.width) < 8
        }) { return match }
        return copy(app, kAXFocusedWindowAttribute).map { $0 as! AXUIElement } ?? windows.first
    }

    private static func bestLabel(_ element: AXUIElement) -> String {
        for attribute in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXHelpAttribute] {
            if let s = string(element, attribute)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
                let flat = s.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\"", with: "'")
                return flat.count > 60 ? String(flat.prefix(57)) + "..." : flat
            }
        }
        return ""
    }

    private static func copy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value
    }

    private static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        copy(element, attribute) as? String
    }

    private static func children(_ element: AXUIElement) -> [AXUIElement] {
        (copy(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    }

    private static func frame(_ element: AXUIElement) -> CGRect? {
        guard let posRef = copy(element, kAXPositionAttribute), let sizeRef = copy(element, kAXSizeAttribute),
              CFGetTypeID(posRef) == AXValueGetTypeID(), CFGetTypeID(sizeRef) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(posRef as! AXValue, .cgPoint, &point)
        AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
        return CGRect(origin: point, size: size)
    }
}
