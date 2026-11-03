import Carbon.HIToolbox
import Cocoa
import QuartzCore

/// Esc while Relay Assist is on screen. Measured (posted Esc, RelayBuddy.log "esc ... received via"): with
/// Accessibility a passive global key monitor gets it and Esc still reaches the app underneath; without it
/// macOS gives global monitors no keys, but a Carbon hotkey for Esc (needs no permission) still fires. So
/// without Accessibility `grab` (the overlay, which is up for seconds) holds that hotkey while active; it
/// takes those Esc presses from the app underneath, which is why the lesson list (up for minutes, over an
/// app that needs Esc) never grabs.
@MainActor
final class EscKey {
    var onEsc: (() -> Void)?
    private let name: String
    private let grab: Bool
    private var monitors: [Any] = []
    private var ref: EventHotKeyRef?
    private static var grabbing: EscKey?
    private static var handlerInstalled = false
    private static var logged: Set<String> = []
    nonisolated private static let signature = OSType(0x52_42_45_53)  // "RBES"

    init(name: String, grab: Bool) {
        self.name = name
        self.grab = grab
    }

    func activate() {
        guard monitors.isEmpty, ref == nil else { return }
        let trusted = AXIsProcessTrusted()
        if trusted, let m = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: { [weak self] event in
            guard event.keyCode == UInt16(kVK_Escape) else { return }
            MainActor.assumeIsolated { self?.fire("global key monitor") }
        }) { monitors.append(m) }
        // Our own panels, when one of them has the keyboard.
        if let m = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { [weak self] event in
            guard event.keyCode == UInt16(kVK_Escape) else { return event }
            MainActor.assumeIsolated { self?.fire("local monitor") }
            return nil
        }) { monitors.append(m) }
        var path = trusted ? "global key monitor (Accessibility granted)" : "local monitor only (no Accessibility: global monitors get no keys)"
        if grab, !trusted {
            Self.installHandler()
            let id = EventHotKeyID(signature: Self.signature, id: 1)
            if RegisterEventHotKey(UInt32(kVK_Escape), 0, id, GetApplicationEventTarget(), 0, &ref) == noErr {
                Self.grabbing = self
                path = "Carbon Esc hotkey while visible (no Accessibility)"
            } else {
                ref = nil
                path += ", Carbon Esc hotkey FAILED to register"
            }
        }
        if Self.logged.insert(name + path).inserted { Log.info("esc (\(name)): listening via \(path)") }
    }

    func deactivate() {
        monitors.forEach(NSEvent.removeMonitor)
        monitors.removeAll()
        if let ref { UnregisterEventHotKey(ref) }
        ref = nil
        if Self.grabbing === self { Self.grabbing = nil }
    }

    private func fire(_ via: String) {
        Log.info("esc (\(name)): received via \(via)")
        onEsc?()
    }

    private static func installHandler() {
        guard !handlerInstalled else { return }
        handlerInstalled = true
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            guard id.signature == EscKey.signature else { return OSStatus(eventNotHandledErr) }
            DispatchQueue.main.async { MainActor.assumeIsolated { EscKey.grabbing?.fire("Carbon hotkey") } }
            return noErr
        }, 1, &spec, nil, nil)
    }
}

enum Palette {
    /// The answering assistant's accent (agents.json avatar.colors.accent); written on the main thread
    /// by Overlay.setAssistant before anything is drawn for an ask.
    nonisolated(unsafe) static var accent = NSColor(srgbRed: 0.969, green: 0.404, blue: 0.027, alpha: 1)  // Nova #f76707
    static var deepAccent: NSColor { accent.blended(withFraction: 0.18, of: .black) ?? accent }
    static let ink = NSColor(srgbRed: 0.043, green: 0.106, blue: 0.227, alpha: 1)       // #0B1B3A
    static let panel = NSColor(srgbRed: 0.106, green: 0.118, blue: 0.141, alpha: 0.96)  // #1B1E24
    static let muted = NSColor(white: 0.66, alpha: 1)
    static let faint = NSColor(white: 0.48, alpha: 1)
}

/// Global AppKit point (bottom-left origin) from a global CoreGraphics point (top-left origin).
func appKitPoint(_ p: CGPoint) -> CGPoint {
    CGPoint(x: p.x, y: (NSScreen.screens.first?.frame.height ?? 0) - p.y)
}

func appKitRect(_ r: CGRect) -> CGRect {
    CGRect(x: r.minX, y: (NSScreen.screens.first?.frame.height ?? 0) - r.maxY, width: r.width, height: r.height)
}

/// Full-screen, transparent, click-through window on every Space. Never key, never main.
final class OverlayWindow: NSWindow {
    init(screen: NSScreen) {
        super.init(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        isReleasedWhenClosed = false
        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.assistiveTechHighWindow)))
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        let view = NSView(frame: CGRect(origin: .zero, size: screen.frame.size))
        view.wantsLayer = true
        view.layer?.masksToBounds = false
        contentView = view
        setFrame(screen.frame, display: false)
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Shows Buddy: think at the cursor, glide to each target, pulse, caption, fade.
@MainActor
final class OverlayController {
    var onDismiss: (() -> Void)?
    /// Fired when the user (or --undo) presses the Undo pill: a plan they undid is not worth caching.
    var onUndo: (() -> Void)?
    private(set) var isShowing = false

    private var window: OverlayWindow?
    private var screenFrame: CGRect = .zero
    private let buddy = BuddyCharacter()
    private var marks: [CALayer] = []
    private var monitors: [Any] = []
    private lazy var esc: EscKey = {
        let key = EscKey(name: "overlay", grab: true)
        key.onEsc = { [weak self] in
            self?.dismiss(fast: true)
            self?.onEscape?()
        }
        return key
    }()
    /// Esc pressed while Buddy was showing (after it dismissed): the app also ends a running lesson.
    var onEscape: (() -> Void)?
    private var fadeWork: DispatchWorkItem?
    /// Bumped on every show or dismiss; stale animation callbacks compare against it.
    private var generation = 0
    /// Buddy's tip in global AppKit coordinates.
    private var tip: CGPoint = .zero

    static let restingOffset = CGPoint(x: 22, y: -6)

    // MARK: Public

    /// The assistant answering from now on: her colours on every mark, her name and avatar on the cursor.
    func setAssistant(_ assistant: Assistant) {
        Palette.accent = assistant.accent
        buddy.setIdentity(name: assistant.title, accent: assistant.accent, avatar: Assistants.avatar(for: assistant))
    }

    func showThinking(near mouse: CGPoint, appName: String) {
        begin(at: CGPoint(x: mouse.x + Self.restingOffset.x, y: mouse.y + Self.restingOffset.y))
        buddy.setThinking(true, text: "Looking at \(appName)")
        layoutCaption()
    }

    /// A caption-only message (errors, "can't see that"). `near` nil keeps Buddy where it is.
    func showMessage(_ text: String, near mouse: CGPoint?) {
        if !isShowing || mouse != nil {
            let m = mouse ?? NSEvent.mouseLocation
            begin(at: CGPoint(x: m.x + Self.restingOffset.x, y: m.y + Self.restingOffset.y))
        }
        buddy.setThinking(false, text: text)
        layoutCaption()
        scheduleFade(after: dwell(for: text))
    }

    /// `hold`: keep the caption up until dismissed (Esc or a click) instead of fading, for long explanations.
    func perform(_ plan: Plan, context: ScreenContext, stay: Bool, hold: Bool = false) {
        if !isShowing { begin(at: CGPoint(x: NSEvent.mouseLocation.x + Self.restingOffset.x, y: NSEvent.mouseLocation.y + Self.restingOffset.y)) }
        buddy.setStaying(stay)
        let steps = plan.steps.prefix(3).map { resolve($0, context: context) }
        let firstCaption = plan.say ?? steps.first?.label ?? "Done"
        guard !steps.isEmpty else {
            buddy.setThinking(false, text: firstCaption)
            layoutCaption()
            if !stay && !hold { scheduleFade(after: dwell(for: firstCaption)) }
            return
        }
        run(steps, index: 0, firstCaption: firstCaption, stay: stay || hold, generation: generation)
    }

    func dismiss(fast: Bool) {
        guard isShowing else { return }
        isShowing = false
        generation += 1
        let finishing = generation
        removeMonitors()
        fadeWork?.cancel()
        fadeWork = nil
        let duration = fast ? 0.12 : 0.35
        undoPill?.hide(duration: duration)
        let layers = [buddy.root] + marks
        CATransaction.begin()
        CATransaction.setAnimationDuration(duration)
        CATransaction.setCompletionBlock { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.generation == finishing else { return }
                self.clearMarks()
                self.buddy.setThinking(false, text: "")
                if self.stepPill == nil { self.window?.orderOut(nil) }
            }
        }
        layers.forEach { $0.opacity = 0 }
        CATransaction.commit()
        onDismiss?()
    }

    // MARK: Chores, Undo, lesson pill

    /// Updates the caption in place (Buddy stays where it is).
    func setCaption(_ text: String) {
        guard isShowing else { return }
        buddy.setThinking(false, text: text)
        layoutCaption()
    }

    /// Glides along a dotted trail to where a chore happens and shows a click there.
    /// `point` is in screenshot pixels; nil clicks where Buddy is.
    func chore(at point: CGPoint?, context: ScreenContext, caption: String) async {
        if !isShowing { begin(at: CGPoint(x: NSEvent.mouseLocation.x + Self.restingOffset.x, y: NSEvent.mouseLocation.y + Self.restingOffset.y)) }
        let token = generation
        fadeWork?.cancel()
        buddy.setThinking(false, text: caption)
        clearMarks()
        let target = point.map { appKitPoint(context.globalPoint($0)) } ?? tip
        moveToScreen(containing: target)
        let from = tip
        tip = target
        layoutCaption()
        let distance = hypot(target.x - from.x, target.y - from.y)
        let duration = min(0.9, max(0.45, 0.35 + Double(distance) / 2500))
        buddy.look(toward: CGPoint(x: target.x - from.x, y: target.y - from.y))
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let path = buddy.glide(from: local(from), to: local(target), duration: duration) { [weak self] in
                if let self, token == self.generation {
                    self.buddy.land()
                    self.addLayer(Marks.click(at: self.local(target), scale: self.window?.backingScaleFactor ?? 2))
                }
                continuation.resume()
            }
            if let path { addLayer(Marks.trail(path, duration: duration, scale: window?.backingScaleFactor ?? 2)) }
        }
        try? await Task.sleep(nanoseconds: 350_000_000)
    }

    /// A small Undo pill beside the caption; it fades with Buddy. `withTitle` repeats what Buddy
    /// did, for when the caption moves on to the next instruction.
    func showUndo(_ record: UndoRecord, withTitle: Bool) {
        let pill = undoPill ?? UndoPill()
        undoPill = pill
        pill.configure(title: withTitle ? record.title : nil) { [weak self] in
            guard let self else { return }
            self.onUndo?()
            self.undoPill?.hide(duration: 0.15)
            self.setCaption("Undoing...")
            Task { @MainActor in
                let ok = await record.perform()
                Log.info("undo \(ok ? "ok" : "failed"): \(record.title)")
                self.showMessage(ok ? "Undone" : "I couldn't undo that one", near: nil)
            }
        }
        positionUndoPill()
        pill.show()
    }

    /// Same as clicking the Undo pill (for scripts and tests).
    func undoNow() {
        guard undoPill?.isVisible == true else { return Log.info("undo: nothing to undo") }
        undoPill?.trigger()
    }

    /// True while an Undo pill is on screen (a plan with a chore is not trusted until it goes away unpressed).
    var undoAvailable: Bool { undoPill?.isVisible == true }

    private var undoPill: UndoPill?
    private var stepPill: CALayer?
    private var stepPillWork: DispatchWorkItem?

    /// "Step 2 of 3 · Scale it" near the user's cursor; hides itself after a few seconds.
    func showStepPill(_ text: String) {
        let mouse = NSEvent.mouseLocation
        moveToScreen(containing: isShowing ? tip : mouse, force: window == nil)
        guard let root = window?.contentView?.layer else { return }
        stepPill?.removeFromSuperlayer()
        let pill = Marks.pill(text, scale: window?.backingScaleFactor ?? 2)
        let origin = local(CGPoint(x: mouse.x + 16, y: mouse.y + 18))
        pill.frame.origin = CGPoint(x: min(origin.x, screenFrame.width - pill.bounds.width - 8),
                                    y: min(origin.y, screenFrame.height - pill.bounds.height - 8))
        root.addSublayer(pill)
        stepPill = pill
        window?.orderFrontRegardless()
        stepPillWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, let pill = self.stepPill else { return }
            CATransaction.begin()
            CATransaction.setAnimationDuration(0.4)
            CATransaction.setCompletionBlock { MainActor.assumeIsolated {
                pill.removeFromSuperlayer()
                if self.stepPill === pill { self.stepPill = nil }
                if !self.isShowing, self.stepPill == nil { self.window?.orderOut(nil) }
            } }
            pill.opacity = 0
            CATransaction.commit()
        }
        stepPillWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.5, execute: work)
    }

    private func addLayer(_ layer: CALayer) {
        guard let root = window?.contentView?.layer else { return }
        root.insertSublayer(layer, below: buddy.root)
        marks.append(layer)
    }

    private func positionUndoPill() {
        guard let pill = undoPill else { return }
        let caption = buddy.captionFrame
        let anchor = CGPoint(x: tip.x + caption.maxX + 8, y: tip.y + caption.minY)
        var origin = CGPoint(x: anchor.x, y: anchor.y + (caption.height - pill.frame.height) / 2)
        if origin.x + pill.frame.width > screenFrame.maxX - 8 {
            origin = CGPoint(x: tip.x + caption.minX, y: tip.y + caption.minY - pill.frame.height - 6)
        }
        pill.setFrameOrigin(origin)
    }

    // MARK: Steps

    private struct ResolvedStep {
        enum Shape { case point(CGPoint), rect(CGRect) }
        let shape: Shape
        let tip: CGPoint
        let label: String
    }

    private func resolve(_ step: PlanStep, context: ScreenContext) -> ResolvedStep {
        switch step.kind {
        case .point(let p):
            let global = appKitPoint(context.globalPoint(p))
            return ResolvedStep(shape: .point(global), tip: global, label: step.label)
        case .highlight(let r):
            let global = appKitRect(context.globalRect(r))
            // Rest the tip just inside the bottom edge so Buddy's body sits below, not on top.
            let tip = CGPoint(x: global.midX, y: global.minY + min(10, global.height * 0.25))
            return ResolvedStep(shape: .rect(global), tip: tip, label: step.label)
        }
    }

    private func run(_ steps: [ResolvedStep], index: Int, firstCaption: String, stay: Bool, generation token: Int) {
        guard token == generation, index < steps.count else { return }
        let step = steps[index]
        moveToScreen(containing: step.tip)
        let caption = index == 0 ? firstCaption : (step.label.isEmpty ? firstCaption : step.label)
        buddy.setThinking(false, text: caption)
        clearMarks()
        let from = tip
        tip = step.tip
        layoutCaption()
        positionUndoPill()
        let distance = hypot(step.tip.x - from.x, step.tip.y - from.y)
        let duration = min(0.9, max(0.45, 0.35 + Double(distance) / 2500))
        buddy.look(toward: CGPoint(x: step.tip.x - from.x, y: step.tip.y - from.y))
        buddy.glide(from: local(from), to: local(step.tip), duration: duration) { [weak self] in
            guard let self, token == self.generation else { return }
            self.buddy.land()
            self.mark(step.shape)
            if index + 1 < steps.count {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.4 + self.readingExtra(caption)) { [weak self] in
                    self?.run(steps, index: index + 1, firstCaption: firstCaption, stay: stay, generation: token)
                }
            } else if !stay {
                self.scheduleFade(after: self.dwell(for: caption))
            }
        }
    }

    // MARK: Pieces

    private func begin(at point: CGPoint) {
        generation += 1
        fadeWork?.cancel()
        fadeWork = nil
        clearMarks()
        undoPill?.hide(duration: 0.1)
        tip = point
        moveToScreen(containing: point, force: window == nil)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        buddy.root.removeAllAnimations()
        buddy.root.position = local(point)
        buddy.root.opacity = 1
        CATransaction.commit()
        if !isShowing { buddy.appear() }
        window?.orderFrontRegardless()
        isShowing = true
        installMonitors()
    }

    private func moveToScreen(containing point: CGPoint, force: Bool = false) {
        let screen = NSScreen.screens.first(where: { NSMouseInRect(point, $0.frame, false) })
            ?? NSScreen.screens.min(by: { distance(point, $0.frame) < distance(point, $1.frame) })
            ?? NSScreen.main!
        if window == nil {
            let w = OverlayWindow(screen: screen)
            w.contentView?.layer?.addSublayer(buddy.root)
            window = w
        }
        guard force || screen.frame != screenFrame else { return }
        screenFrame = screen.frame
        window?.setFrame(screen.frame, display: false)
        buddy.setContentsScale(screen.backingScaleFactor)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        // Jump to the nearest point on the new screen; the glide continues from there.
        let clamped = CGPoint(x: min(max(tip.x, screenFrame.minX + 40), screenFrame.maxX - 40),
                              y: min(max(tip.y, screenFrame.minY + 40), screenFrame.maxY - 40))
        tip = clamped
        buddy.root.position = local(clamped)
        CATransaction.commit()
    }

    private func distance(_ p: CGPoint, _ r: CGRect) -> CGFloat {
        let dx = max(r.minX - p.x, 0, p.x - r.maxX)
        let dy = max(r.minY - p.y, 0, p.y - r.maxY)
        return hypot(dx, dy)
    }

    private func local(_ global: CGPoint) -> CGPoint {
        CGPoint(x: global.x - screenFrame.minX, y: global.y - screenFrame.minY)
    }

    private func layoutCaption() {
        buddy.layoutLabels(tip: local(tip), in: CGRect(origin: .zero, size: screenFrame.size))
    }

    private func mark(_ shape: ResolvedStep.Shape) {
        guard let root = window?.contentView?.layer else { return }
        let scale = window?.backingScaleFactor ?? 2
        let layer: CALayer
        switch shape {
        case .point(let p):
            layer = Marks.ring(at: local(p), scale: scale)
        case .rect(let r):
            layer = Marks.outline(CGRect(origin: local(r.origin), size: r.size), scale: scale)
        }
        root.insertSublayer(layer, below: buddy.root)
        marks.append(layer)
    }

    private func clearMarks() {
        marks.forEach { $0.removeFromSuperlayer() }
        marks.removeAll()
    }

    private func readingExtra(_ text: String) -> TimeInterval {
        min(1.0, Double(max(0, text.count - 40)) * 0.03)
    }

    /// About 2 s after arriving, a bit longer for long captions; 4 s while an Undo pill is up,
    /// so there is time to reach it.
    private func dwell(for text: String) -> TimeInterval {
        let base = 2.0 + readingExtra(text)
        return undoPill?.isVisible == true ? max(base, 4.0) : base
    }

    /// True while the answering assistant is still speaking; the caption waits for her to finish.
    var isSpeaking: (() -> Bool)?

    private func scheduleFade(after delay: TimeInterval) {
        fadeWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            // Hovering the Undo pill holds Buddy until the pointer leaves.
            if let pill = self.undoPill, pill.isVisible, NSMouseInRect(NSEvent.mouseLocation, pill.frame, false) {
                return self.scheduleFade(after: 1.0)
            }
            // Never cut her off: stay up while the answer is still being spoken, then linger briefly.
            if self.isSpeaking?() == true {
                return self.scheduleFade(after: 0.8)
            }
            self.dismiss(fast: false)
        }
        fadeWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// Passive monitors: they see clicks and Esc meant for other apps without consuming them.
    private func installMonitors() {
        guard monitors.isEmpty else { return }
        if let click = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown], handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.dismiss(fast: true) }
        }) { monitors.append(click) }
        esc.activate()
    }

    private func removeMonitors() {
        monitors.forEach(NSEvent.removeMonitor)
        monitors.removeAll()
        esc.deactivate()
    }
}

/// Ring and outline marks that pulse where Buddy points.
enum Marks {
    static func ring(at center: CGPoint, scale: CGFloat) -> CALayer {
        let container = CALayer()
        container.position = center
        container.bounds = CGRect(x: -20, y: -20, width: 40, height: 40)
        container.contentsScale = scale
        let radius: CGFloat = 16
        let circle = CGPath(ellipseIn: CGRect(x: -radius, y: -radius, width: radius * 2, height: radius * 2), transform: nil)

        let ring = CAShapeLayer()
        ring.path = circle
        ring.fillColor = Palette.accent.withAlphaComponent(0.16).cgColor
        ring.strokeColor = Palette.accent.cgColor
        ring.lineWidth = 2.5
        ring.contentsScale = scale
        container.addSublayer(ring)

        let pulse = CAShapeLayer()
        pulse.path = circle
        pulse.fillColor = NSColor.clear.cgColor
        pulse.strokeColor = Palette.accent.cgColor
        pulse.lineWidth = 2
        pulse.opacity = 0
        pulse.contentsScale = scale
        container.addSublayer(pulse)

        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 1
        grow.toValue = 2.3
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.9
        fade.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [grow, fade]
        group.duration = 0.85
        group.repeatCount = 3
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        pulse.add(group, forKey: "pulse")

        let pop = CASpringAnimation(keyPath: "transform.scale")
        pop.fromValue = 0.3
        pop.toValue = 1
        pop.damping = 11
        pop.initialVelocity = 6
        pop.duration = pop.settlingDuration
        ring.add(pop, forKey: "pop")
        return container
    }

    static func outline(_ rect: CGRect, scale: CGFloat) -> CALayer {
        let frame = rect.insetBy(dx: -5, dy: -5)
        let path = CGPath(roundedRect: frame, cornerWidth: 8, cornerHeight: 8, transform: nil)
        let container = CALayer()
        container.contentsScale = scale

        let outline = CAShapeLayer()
        outline.path = path
        outline.fillColor = Palette.accent.withAlphaComponent(0.08).cgColor
        outline.strokeColor = Palette.accent.cgColor
        outline.lineWidth = 2.5
        outline.contentsScale = scale
        container.addSublayer(outline)

        let glow = CAShapeLayer()
        glow.path = path
        glow.fillColor = NSColor.clear.cgColor
        glow.strokeColor = Palette.accent.cgColor
        glow.lineWidth = 2
        glow.opacity = 0
        glow.contentsScale = scale
        container.addSublayer(glow)

        let width = CABasicAnimation(keyPath: "lineWidth")
        width.fromValue = 2
        width.toValue = 12
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.7
        fade.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [width, fade]
        group.duration = 0.9
        group.repeatCount = 3
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        glow.add(group, forKey: "pulse")

        let appear = CABasicAnimation(keyPath: "opacity")
        appear.fromValue = 0
        appear.toValue = 1
        appear.duration = 0.18
        outline.add(appear, forKey: "appear")
        return container
    }
}
