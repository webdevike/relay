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
