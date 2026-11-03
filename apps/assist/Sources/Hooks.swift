import Cocoa

/// Optional per-app integration: live state for the model, a reliable way to act, undo, and
/// completion checks for lessons. Apps without a hook use screenshots + AX + cua-driver only.
protocol AppHook: Sendable {
    var name: String { get }
    /// What the app's own API says right now, as a few lines for the prompt.
    func sceneState() async -> String?
    /// Opaque state fingerprint: undo target and change detection.
    func snapshot() async -> String?
    /// Runs one action the hook owns; false means "not mine, use the generic path".
    func run(_ action: BuddyAction) async throws -> Bool
    /// Steps back until the state matches `snapshot` again.
    func undo(to snapshot: String) async -> Bool
    /// Evaluates a lesson step's completion check.
    func check(_ expression: String) async -> Bool?
    /// Extra rules for the model about acting in this app.
    var promptNotes: String { get }
}

enum AppHooks {
    /// RELAY_BUDDY_HOOKS: comma list of enabled hooks (default "blender,linear"); "none" disables all.
    private static let enabled: Set<String> = {
        let raw = ProcessInfo.processInfo.environment["RELAY_BUDDY_HOOKS"] ?? "blender,linear"
        return Set(raw.lowercased().split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
    }()

    static func hook(for target: TargetApp) -> AppHook? {
        if enabled.contains("blender"), target.bundleID == "org.blenderfoundation.blender" { return BlenderHook() }
        if enabled.contains("linear"), target.bundleID == LinearHook.bundleID { return LinearHook(pid: target.pid) }
        return nil
    }
}

enum HookError: LocalizedError {
    case unreachable(String)
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .unreachable(let why): return "I can't reach the app's add-on: \(why)"
        case .failed(let why): return "That didn't work: \(why)"
        }
    }
}

// MARK: Blender

/// Talks to the MCP for Blender add-on's socket (the same one the Blender MCP server uses):
/// JSON `{"type":"execute_code","params":{"code":...}}` in, `{"status","result":{"result":stdout}}` out.
enum BlenderLink {
    static let port: UInt16 = UInt16(ProcessInfo.processInfo.environment["BLENDER_PORT"] ?? "") ?? 9877

    static func execute(_ code: String, timeout: TimeInterval = 10) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do { continuation.resume(returning: try executeBlocking(code, timeout: timeout)) } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private static func executeBlocking(_ code: String, timeout: TimeInterval) throws -> String {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw HookError.unreachable("no socket") }
        defer { close(fd) }
        var tv = timeval(tv_sec: Int(timeout), tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let connected = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard connected == 0 else { throw HookError.unreachable("Blender add-on not listening on port \(port)") }

        let request = try JSONSerialization.data(withJSONObject: ["type": "execute_code", "params": ["code": code]])
        let sent = request.withUnsafeBytes { send(fd, $0.baseAddress, request.count, 0) }
        guard sent == request.count else { throw HookError.unreachable("send failed") }

        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = recv(fd, &chunk, chunk.count, 0)
            guard n > 0 else { throw HookError.unreachable(n == 0 ? "connection closed" : "timed out") }
            buffer.append(chunk, count: n)
            // The add-on sends one JSON object and keeps the connection open: stop once it parses.
            guard let json = try? JSONSerialization.jsonObject(with: buffer) as? [String: Any] else { continue }
            if json["status"] as? String == "success", let result = json["result"] as? [String: Any] {
                if let error = result["error"] as? String { throw HookError.failed(error) }
                return result["result"] as? String ?? ""
            }
            let message = (json["message"] as? String) ?? ((json["result"] as? [String: Any])?["error"] as? String) ?? "unknown error"
            throw HookError.failed(message)
        }
    }

    /// Python helpers every Buddy script starts with.
    static let prelude = #"""
    import bpy, json
    def _buddy_ctx():
        for win in bpy.context.window_manager.windows:
            for area in win.screen.areas:
                if area.type == 'VIEW_3D':
                    region = next(r for r in area.regions if r.type == 'WINDOW')
                    return bpy.context.temp_override(window=win, screen=win.screen, area=area, region=region)
        return bpy.context.temp_override()
    def _buddy_fp():
        vl = bpy.context.view_layer
        ob = vl.objects.active
        if ob and ob.mode == 'EDIT':
            ob.update_from_editmode()
        parts = [bpy.context.mode, ob.name if ob else '']
        for o in bpy.context.scene.objects:
            n = ()
            if o.type == 'MESH':
                n = (len(o.data.vertices), sum(p.use_smooth for p in o.data.polygons))
            t = tuple(round(v, 4) for v in (*o.location, *o.rotation_euler, *o.scale))
            mods = tuple((m.name, m.type, m.show_viewport) for m in o.modifiers)
            parts.append((o.name, o.type, o.select_get(), t, n, mods, len(o.material_slots), o.hide_get()))
        return repr(parts)

    """#
}

struct BlenderHook: AppHook {
    let name = "Blender"

    var promptNotes: String {
        """
        Blender hook: live scene state above comes from Blender's Python API. To act in Blender use \
        do() actions of kind "blender_python" (keys and clicks do not reach Blender). The code runs \
        inside Blender already wrapped in a 3D Viewport context override: call bpy.ops / bpy.data \
        directly, e.g. bpy.ops.object.mode_set(mode='EDIT'). Keep it to a few lines. Never delete \
        objects the user made, never save or open files.
        """
    }

    func sceneState() async -> String? {
        let script = BlenderLink.prelude + #"""
        c = bpy.context
        ob = c.view_layer.objects.active
        tool = ''
        try:
            with _buddy_ctx():
                tool = bpy.context.workspace.tools.from_space_view3d_mode(bpy.context.mode).idname
        except Exception:
            pass
        lines = ['Mode: ' + c.mode, 'Workspace: ' + c.window_manager.windows[0].workspace.name, 'Active tool: ' + tool]
        if ob:
            info = 'Active object: %s (%s)' % (ob.name, ob.type)
            if ob.type == 'MESH':
                if ob.mode == 'EDIT':
                    ob.update_from_editmode()
                me = ob.data
                sm = sum(p.use_smooth for p in me.polygons)
                shade = 'smooth' if sm and sm == len(me.polygons) else ('flat' if sm == 0 else 'mixed')
                info += ', %d verts, %d faces, %s shading' % (len(me.vertices), len(me.polygons), shade)
                if ob.mode == 'EDIT':
                    info += ', %d verts selected' % sum(v.select for v in me.vertices)
            info += ', scale (%.3f, %.3f, %.3f)' % tuple(ob.scale)
            lines.append(info)
        lines.append('Selected objects: ' + (', '.join(o.name for o in c.selected_objects) or 'none'))
        lines.append('Objects: ' + ', '.join('%s (%s)' % (o.name, o.type) for o in list(c.scene.objects)[:30]))
        print('\n'.join(lines))
        """#
        return try? await BlenderLink.execute(script, timeout: 3).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Editor areas, their regions and the toolbar's tools (current mode, plus Edit Mode when in Object Mode
    /// with a mesh), straight from Blender's window data: positions that do not depend on reading pixels.
    func layout() async -> [String: Any]? {
        let script = BlenderLink.prelude + #"""
        w = bpy.context.window_manager.windows[0]
        def _tools(mode):
            from bl_ui.space_toolsystem_common import ToolSelectPanelHelper
            cls = ToolSelectPanelHelper._tool_class_from_space_type('VIEW_3D')
            out = []
            with _buddy_ctx():
                for t in cls.tools_from_context(bpy.context, mode=mode):
                    if t is None:
                        out.append(None)
                        continue
                    t = t[0] if isinstance(t, tuple) else t
                    out.append(t.split('.')[-1].replace('_', ' ').title() if isinstance(t, str) else getattr(t, 'label', '?'))
            return out
        areas = [[a.type, a.x, a.y, a.width, a.height,
                  [[r.type, r.x, r.y, r.width, r.height] for r in a.regions if r.width > 1 and r.height > 1]]
                 for a in w.screen.areas]
        tools = {}
        try:
            tools[bpy.context.mode] = _tools(bpy.context.mode)
            ob = bpy.context.view_layer.objects.active
            if bpy.context.mode == 'OBJECT' and ob and ob.type == 'MESH':
                tools['EDIT_MESH'] = _tools('EDIT_MESH')
        except Exception:
            pass
        print(json.dumps({'win': [w.width, w.height], 'unit': 20 * bpy.context.preferences.system.ui_scale,
                          'mode': bpy.context.mode, 'areas': areas, 'tools': tools}))
        """#
        guard let out = try? await BlenderLink.execute(script, timeout: 3) else { return nil }
        return (try? JSONSerialization.jsonObject(with: Data(out.utf8))) as? [String: Any]
    }

    func snapshot() async -> String? {
        try? await BlenderLink.execute(BlenderLink.prelude + "print(_buddy_fp())", timeout: 3)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func run(_ action: BuddyAction) async throws -> Bool {
        guard action.kind == .blenderPython, let code = action.code, !code.isEmpty else { return false }
        let script = BlenderLink.prelude + """
        _BUDDY_CODE = \(Self.pythonString(code))
        with _buddy_ctx():
            exec(compile(_BUDDY_CODE, '<buddy>', 'exec'), {'bpy': bpy, '__name__': 'buddy'})
        bpy.ops.ed.undo_push(message='Buddy: ' + \(Self.pythonString(action.description)))
        print('ok')
        """
        _ = try await BlenderLink.execute(script)
        return true
    }

    func undo(to snapshot: String) async -> Bool {
        // Blender's Python API cannot list the undo stack, and one operator can push several
        // steps, so step back until the scene matches what it was before Buddy acted.
        let script = BlenderLink.prelude + """
        _target = \(Self.pythonString(snapshot))
        _ok = _buddy_fp() == _target
        for _i in range(12):
            if _ok:
                break
            with _buddy_ctx():
                bpy.ops.ed.undo()
            _ok = _buddy_fp() == _target
        print('ok' if _ok else 'partial')
        """
        return (try? await BlenderLink.execute(script))?.contains("ok") == true
    }

    func check(_ expression: String) async -> Bool? {
        let script = BlenderLink.prelude + """
        obj = bpy.context.view_layer.objects.active
        if obj and obj.mode == 'EDIT':
            obj.update_from_editmode()
        _env = {'bpy': bpy, 'obj': obj, 'scene': bpy.context.scene, 'mode': bpy.context.mode}
        try:
            print('YES' if eval(\(Self.pythonString(expression)), _env) else 'NO')
        except Exception as e:
            print('ERR', e)
        """
        guard let out = try? await BlenderLink.execute(script, timeout: 3) else { return nil }
        if out.hasPrefix("YES") { return true }
        if out.hasPrefix("NO") { return false }
        Log.info("lesson check error: \(out.trimmingCharacters(in: .whitespacesAndNewlines)) for \(expression)")
        return nil
    }

    /// A Python string literal (JSON string syntax is valid Python).
    static func pythonString(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s], options: .withoutEscapingSlashes)) ?? Data("[\"\"]".utf8)
        let array = String(decoding: data, as: UTF8.self)
        return String(array.dropFirst().dropLast())
    }
}

/// Blender's layout (BlenderHook.layout) in screenshot pixels: editor areas and regions exactly, and the
/// toolbar's tool buttons from the tool list and Blender's toolbar spacing (1.2 units to the first button
/// centre, 1.725 units per button, 0.35 per gap; measured on Blender 5.2). Feeds the prompt, and turns a
/// model's point at a named tool into that button's rect (confirmed bounds the overlay may outline).
struct BlenderLayout {
    struct Item { let name: String; let rect: CGRect; let mode: String? }
    let regions: [Item]
    let tools: [Item]
    let mode: String

    private static let areaNames = ["VIEW_3D": "3D Viewport", "PROPERTIES": "Properties editor", "OUTLINER": "Outliner",
                                    "DOPESHEET_EDITOR": "Timeline", "TIMELINE": "Timeline", "IMAGE_EDITOR": "Image editor",
                                    "NODE_EDITOR": "Node editor"]
    private static let regionNames = ["HEADER": "header", "TOOL_HEADER": "tool settings bar", "TOOLS": "toolbar", "UI": "sidebar (N panel)"]

    init?(_ raw: [String: Any]?, context: ScreenContext) {
        guard let raw, let win = raw["win"] as? [Double], win.count == 2, win[0] > 0,
              let areas = raw["areas"] as? [[Any]] else { return nil }
        let s = Double(context.imageSize.width) / win[0]
        let titleBar = Double(context.imageSize.height) - win[1] * s
        func rect(_ v: [Any]) -> CGRect? {
            let n = v.compactMap { ($0 as? NSNumber)?.doubleValue }
            guard n.count == 4 else { return nil }
            return CGRect(x: n[0] * s, y: titleBar + (win[1] - (n[1] + n[3])) * s, width: n[2] * s, height: n[3] * s)
        }
        var regions: [Item] = []
        var toolbar: CGRect?
        for area in areas where area.count == 6 {
            guard let type = area[0] as? String, let areaRect = rect(Array(area[1...4])) else { continue }
            let areaName = Self.areaNames[type] ?? type.lowercased().replacingOccurrences(of: "_", with: " ")
            regions.append(Item(name: areaName, rect: areaRect, mode: nil))
            for region in (area[5] as? [[Any]]) ?? [] where region.count == 5 {
                guard let rtype = region[0] as? String, let name = Self.regionNames[rtype], let r = rect(Array(region[1...4])) else { continue }
                regions.append(Item(name: "\(areaName) \(name)", rect: r, mode: nil))
                if type == "VIEW_3D", rtype == "TOOLS" { toolbar = r }
            }
        }
        var tools: [Item] = []
        let unit = ((raw["unit"] as? NSNumber)?.doubleValue ?? 20) * s
        if let toolbar, Double(toolbar.width) < unit * 1.725 * 1.8, let lists = raw["tools"] as? [String: [Any]] {
            for (mode, list) in lists {
                var gaps = 0, index = 0
                for entry in list {
                    guard let name = entry as? String else { gaps += 1; continue }
                    let cy = Double(toolbar.minY) + unit * (1.2 + 1.725 * Double(index) + 0.35 * Double(gaps))
                    let size = unit * 1.7
                    tools.append(Item(name: name, rect: CGRect(x: Double(toolbar.midX) - size / 2, y: cy - size / 2, width: size, height: size), mode: mode))
                    index += 1
                }
            }
        }
        self.regions = regions
        self.tools = tools
        self.mode = raw["mode"] as? String ?? ""
    }

    private static func box(_ r: CGRect) -> String {
        "[\(Int(r.minX)),\(Int(r.minY)),\(Int(r.width)),\(Int(r.height))]"
    }

    var prompt: String {
        var lines = ["Blender layout from its API, in screenshot pixels [x,y,w,h] (exact; use these instead of guessing from the image):"]
        lines += regions.map { "- \($0.name) \(Self.box($0.rect))" }
        let modes = Set(tools.compactMap(\.mode))
        for mode in (modes.contains(self.mode) ? [self.mode] : []) + modes.subtracting([self.mode]).sorted() {
            let label = mode == self.mode ? "Toolbar buttons now (\(mode))" : "Toolbar buttons once in \(mode) (after the mode switch)"
            lines.append(label + ": " + tools.filter { $0.mode == mode }.map { "\($0.name) \(Self.box($0.rect))" }.joined(separator: ", "))
        }
        return lines.joined(separator: "\n")
    }

    /// A point at a named toolbar tool snaps to that button (current mode first, then the mode it switches
    /// to) and carries its rect; a highlight matching an editor region carries that region's exact rect.
    func refine(_ steps: [PlanStep]) -> [PlanStep] {
        steps.map { step in
            switch step.kind {
            case .point(let p):
                let nearToolbar = regions.contains { $0.name.hasSuffix("toolbar") && $0.rect.insetBy(dx: -24, dy: -24).contains(p) }
                let candidates = tools.filter { Jev.labelMatches($0.name, target: step.label) }
                guard nearToolbar, let tool = candidates.first(where: { $0.mode == mode }) ?? candidates.first else { return step }
                Log.info("blender layout: \"\(step.label)\" -> toolbar \(tool.name) \(Self.box(tool.rect)) (\(tool.mode ?? "")), model said (\(Int(p.x)),\(Int(p.y)))")
                return PlanStep(kind: .point(CGPoint(x: tool.rect.midX, y: tool.rect.midY)), label: step.label, box: tool.rect)
            case .highlight(let r):
                guard let region = regions.max(by: { Self.iou($0.rect, r) < Self.iou($1.rect, r) }), Self.iou(region.rect, r) > 0.5 else { return step }
                Log.info("blender layout: highlight \"\(step.label)\" -> \(region.name) \(Self.box(region.rect))")
                return PlanStep(kind: .highlight(region.rect), label: step.label, box: region.rect)
            }
        }
    }

    private static func iou(_ a: CGRect, _ b: CGRect) -> CGFloat {
        let i = a.intersection(b)
        guard !i.isNull else { return 0 }
        return i.width * i.height / (a.width * a.height + b.width * b.height - i.width * i.height)
    }
}
