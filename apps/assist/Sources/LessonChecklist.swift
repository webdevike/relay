import Cocoa
import QuartzCore

/// The lesson's step list: a small dark panel with every step, the current one highlighted in the
/// assistant's accent, finished ones checked off. Non-activating (the app being learned keeps focus),
/// mouse-transparent except over its header (the drag handle; it remembers where Isaac dragged it).
/// No buttons: "skip", "stop" (typed or said) or Esc.
@MainActor
final class LessonChecklist {
    enum State { case pending, current, done, skipped }

    var onStop: (() -> Void)?
    private(set) var isVisible = false

    private static let width: CGFloat = 332
    private static let headerHeight: CGFloat = 36
    private static let rowHeight: CGFloat = 46
    private static let bottomInset: CGFloat = 6
    private static let defaultsKey = "lessonChecklistOrigin"

    private var panel: NSPanel?
    private var root: ChecklistRoot?
    private var rows: [ChecklistRow] = []
    private var states: [State] = []
    private var headline: NSTextField?
    private var progress: NSTextField?
    private var closeWork: DispatchWorkItem?
    private var monitors: [Any] = []
    /// Never grabs Esc (a lesson runs for minutes and the app being learned needs its Esc); without
    /// Accessibility, Esc stops the lesson only while the overlay is up (its grab); "stop" works any time.
    private lazy var esc: EscKey = {
        let key = EscKey(name: "lesson list", grab: false)
        key.onEsc = { [weak self] in self?.onStop?() }
        return key
    }()
    private var placing = false
    private var moveObserver: NSObjectProtocol?

    // MARK: Public

    /// Shows the list for a new lesson on the screen holding `windowFrame` (global CoreGraphics coordinates).
    func show(assistant: Assistant, goal: String, steps: [LessonStep], windowFrame: CGRect?) {
        close(animated: false)
        let height = Self.headerHeight + Self.rowHeight * CGFloat(steps.count) + Self.bottomInset
        let size = CGSize(width: Self.width, height: height)
        let panel = NSPanel(contentRect: CGRect(origin: .zero, size: size),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.assistiveTechHighWindow)) + 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false
        panel.isMovableByWindowBackground = true

        let root = ChecklistRoot(frame: CGRect(origin: .zero, size: size))
        root.wantsLayer = true
        root.layer?.backgroundColor = Palette.panel.cgColor
        root.layer?.cornerRadius = 14
        root.layer?.masksToBounds = true
        root.layer?.borderWidth = 0
        root.dragRect = CGRect(x: 0, y: 0, width: size.width, height: Self.headerHeight)
        panel.contentView = root
        self.root = root

        buildHeader(in: root, goal: goal)
        states = Array(repeating: .pending, count: steps.count)
        rows = steps.enumerated().map { index, step in
            let row = ChecklistRow(number: index + 1, title: step.title, instruction: step.instruction,
                                   frame: CGRect(x: 0, y: Self.headerHeight + Self.rowHeight * CGFloat(index),
                                                 width: size.width, height: Self.rowHeight))
            root.addSubview(row)
            return row
        }

        place(panel, size: size, windowFrame: windowFrame)
        self.panel = panel
        isVisible = true
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { $0.duration = 0.2; panel.animator().alphaValue = 1 }
        installMonitors()
    }

    func setCurrent(_ i: Int) {
        guard states.indices.contains(i) else { return }
        states[i] = .current
        rows[i].set(.current, animated: true)
        updateProgress()
    }

    private func updateProgress() {
        let finished = states.filter { $0 == .done || $0 == .skipped }.count
        progress?.stringValue = "\(finished)/\(states.count)"
    }

    func markDone(_ i: Int) {
        guard states.indices.contains(i) else { return }
        states[i] = .done
        rows[i].set(.done, animated: true)
        updateProgress()
    }

    func markSkipped(_ i: Int) {
        guard states.indices.contains(i) else { return }
        states[i] = .skipped
        rows[i].set(.skipped, animated: true)
        updateProgress()
    }

    /// Every step handled: the title turns into "Done ✓" and the panel closes itself after about 3 s.
    func celebrate(goal: String, accent: NSColor) {
        guard panel != nil else { return }
        headline?.stringValue = "Done ✓  \(goal)"
        headline?.textColor = accent
        updateProgress()
        let work = DispatchWorkItem { [weak self] in self?.close(animated: true) }
        closeWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
    }

    func close(animated: Bool = true) {
        closeWork?.cancel()
        closeWork = nil
        removeMonitors()
        if let moveObserver { NotificationCenter.default.removeObserver(moveObserver) }
        moveObserver = nil
        isVisible = false
        guard let old = panel else { return }
        panel = nil
        root = nil
        rows = []
        if animated {
            NSAnimationContext.runAnimationGroup({ $0.duration = 0.25; old.animator().alphaValue = 0 }) {
                MainActor.assumeIsolated { old.orderOut(nil) }
            }
        } else {
            old.orderOut(nil)
        }
    }

    // MARK: Layout

    /// One line: the goal, and a tiny "1/3" progress at the right. It is also the drag handle.
    private func buildHeader(in root: NSView, goal: String) {
        let title = NSTextField(labelWithString: goal.prefix(1).uppercased() + goal.dropFirst())
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.textColor = .white
        title.lineBreakMode = .byTruncatingTail
        title.frame = CGRect(x: 16, y: 11, width: Self.width - 72, height: 17)
        root.addSubview(title)
        headline = title

        let count = NSTextField(labelWithString: "")
        count.font = .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        count.textColor = Palette.faint
        count.alignment = .right
        count.frame = CGRect(x: Self.width - 56, y: 12, width: 40, height: 15)
        root.addSubview(count)
        progress = count
    }

    // MARK: Placement

    /// Off the app being learned (its top-right panels are where lessons point): at the screen edge beside the
    /// target window when there is room (right, then left), else bottom-right of its screen. A position Isaac
    /// dragged to wins when it is still on a screen.
    private func place(_ panel: NSPanel, size: CGSize, windowFrame: CGRect?) {
        placing = true
        defer { DispatchQueue.main.async { [weak self] in self?.placing = false } }
        if let saved = UserDefaults.standard.array(forKey: Self.defaultsKey) as? [Double], saved.count == 2 {
            let rect = CGRect(origin: CGPoint(x: saved[0], y: saved[1]), size: size)
            if NSScreen.screens.contains(where: { $0.visibleFrame.intersects(rect.insetBy(dx: 20, dy: 20)) }) {
                panel.setFrameOrigin(rect.origin)
                Log.info(String(format: "lesson list: placed where it was dragged last, (%.0f, %.0f)", rect.minX, rect.minY))
                observeMoves(panel)
                return
            }
        }
        let screen = windowFrame.flatMap { frame -> NSScreen? in
            let ak = appKitRect(frame)
            return NSScreen.screens.max { $0.frame.intersection(ak).area < $1.frame.intersection(ak).area }
        } ?? NSScreen.main ?? NSScreen.screens[0]
        let visible = screen.visibleFrame
        let margin: CGFloat = 16
        let top = visible.maxY - size.height - margin
        let rightX = visible.maxX - size.width - margin
        let leftX = visible.minX + margin
        let window = windowFrame.map(appKitRect)?.intersection(visible)
        let origin: CGPoint
        let spot: String
        if let window, !window.isNull, rightX >= window.maxX + 8 {
            (origin, spot) = (CGPoint(x: rightX, y: top), "right of the window")
        } else if let window, !window.isNull, leftX + size.width <= window.minX - 8 {
            (origin, spot) = (CGPoint(x: leftX, y: top), "left of the window")
        } else {
            (origin, spot) = (CGPoint(x: rightX, y: visible.minY + margin), "bottom-right (no room beside the window)")
        }
        panel.setFrameOrigin(origin)
        Log.info(String(format: "lesson list: placed %@ at (%.0f, %.0f), window %@", spot, origin.x, origin.y,
                        window.map { NSStringFromRect($0) } ?? "unknown"))
        observeMoves(panel)
    }

    private func observeMoves(_ panel: NSPanel) {
        moveObserver = NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: panel, queue: .main) { [weak self, weak panel] _ in
            MainActor.assumeIsolated {
                guard let self, let panel, !self.placing else { return }
                UserDefaults.standard.set([Double(panel.frame.origin.x), Double(panel.frame.origin.y)], forKey: Self.defaultsKey)
            }
        }
    }

    // MARK: Mouse and keys

    /// The panel is click-through everywhere except its header (drag) and buttons: toggled as the pointer moves.
    private func installMonitors() {
        let update: (NSEvent?) -> Void = { [weak self] _ in MainActor.assumeIsolated { self?.updateMousePassThrough() } }
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged], handler: { update($0) }) { monitors.append(m) }
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved], handler: { update($0); return $0 }) { monitors.append(m) }
        panel?.ignoresMouseEvents = true
        esc.activate()
    }

    private func removeMonitors() {
        monitors.forEach(NSEvent.removeMonitor)
        monitors.removeAll()
        esc.deactivate()
    }

    private func updateMousePassThrough() {
        guard let panel, let root else { return }
        // A drag in progress must keep receiving events.
        if NSEvent.pressedMouseButtons & 1 != 0, !panel.ignoresMouseEvents { return }
        let point = root.convert(panel.convertPoint(fromScreen: NSEvent.mouseLocation), from: nil)
        panel.ignoresMouseEvents = !root.interactive(at: point)
    }
}

private extension CGRect {
    var area: CGFloat { isNull ? 0 : width * height }
}

/// Flipped root view: y grows downward. Only the header (drag handle) takes the mouse.
private final class ChecklistRoot: NSView {
    var dragRect: CGRect = .zero

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { true }

    func interactive(at point: CGPoint) -> Bool { dragRect.contains(point) }
}

/// One numbered step: badge, title, one-line instruction.
private final class ChecklistRow: NSView {
    private let badge = CALayer()
    private let number = CATextLayer()
    private let check = CAShapeLayer()
    private let dash = CAShapeLayer()
    private let titleLabel: NSTextField
    private let detail: NSTextField
    private let highlight = CALayer()
    private let accent = Palette.accent

    override var isFlipped: Bool { true }

    init(number n: Int, title: String, instruction: String, frame: CGRect) {
        titleLabel = NSTextField(labelWithString: title)
        detail = NSTextField(labelWithString: instruction)
        super.init(frame: frame)
        wantsLayer = true
        guard let layer else { return }
        let scale = NSScreen.main?.backingScaleFactor ?? 2

        highlight.frame = CGRect(x: 6, y: 2, width: frame.width - 12, height: frame.height - 4)
        highlight.cornerRadius = 10
        highlight.borderWidth = 1
        highlight.opacity = 0
        highlight.backgroundColor = accent.withAlphaComponent(0.16).cgColor
        highlight.borderColor = accent.withAlphaComponent(0.7).cgColor
        layer.addSublayer(highlight)

        badge.frame = CGRect(x: 16, y: (frame.height - 22) / 2, width: 22, height: 22)
        badge.cornerRadius = 11
        badge.borderWidth = 1.5
        layer.addSublayer(badge)

        number.string = "\(n)"
        number.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        number.fontSize = 11
        number.alignmentMode = .center
        number.frame = CGRect(x: 0, y: 3, width: 22, height: 15)
        number.contentsScale = scale
        badge.addSublayer(number)

        let tick = CGMutablePath()
        tick.move(to: CGPoint(x: 6, y: 11.5))
        tick.addLine(to: CGPoint(x: 9.5, y: 15))
        tick.addLine(to: CGPoint(x: 16, y: 7.5))
        check.path = tick
        check.fillColor = nil
        check.strokeColor = NSColor.white.cgColor
        check.lineWidth = 2
        check.lineCap = .round
        check.lineJoin = .round
        check.strokeEnd = 0
        badge.addSublayer(check)

        let bar = CGMutablePath()
        bar.move(to: CGPoint(x: 6.5, y: 11))
        bar.addLine(to: CGPoint(x: 15.5, y: 11))
        dash.path = bar
        dash.strokeColor = Palette.muted.cgColor
        dash.lineWidth = 2
        dash.lineCap = .round
        dash.opacity = 0
        badge.addSublayer(dash)

        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.frame = CGRect(x: 50, y: 6, width: frame.width - 66, height: 17)
        addSubview(titleLabel)
        detail.font = .systemFont(ofSize: 12)
        detail.lineBreakMode = .byTruncatingTail
        detail.frame = CGRect(x: 50, y: 24, width: frame.width - 66, height: 16)
        addSubview(detail)
        set(.pending, animated: false)
    }

    required init?(coder: NSCoder) { fatalError() }

    func set(_ state: LessonChecklist.State, animated: Bool) {
        let duration: CFTimeInterval = animated ? 0.3 : 0
        CATransaction.begin()
        CATransaction.setAnimationDuration(duration)
        highlight.opacity = state == .current ? 1 : 0
        dash.opacity = state == .skipped ? 1 : 0
        switch state {
        case .pending:
            badge.backgroundColor = NSColor.clear.cgColor
            badge.borderColor = Palette.faint.cgColor
            number.foregroundColor = Palette.faint.cgColor
            number.opacity = 1
            check.strokeEnd = 0
            titleLabel.textColor = Palette.muted
            detail.textColor = Palette.faint
        case .current:
            badge.backgroundColor = accent.cgColor
            badge.borderColor = accent.cgColor
            number.foregroundColor = NSColor.white.cgColor
            number.opacity = 1
            check.strokeEnd = 0
            titleLabel.textColor = .white
            detail.textColor = NSColor(white: 0.85, alpha: 1)
        case .done:
            let green = NSColor(srgbRed: 0.32, green: 0.81, blue: 0.4, alpha: 1)
            badge.backgroundColor = green.cgColor
            badge.borderColor = green.cgColor
            number.opacity = 0
            check.strokeEnd = 1
            titleLabel.textColor = Palette.faint
            detail.textColor = NSColor(white: 0.4, alpha: 1)
        case .skipped:
            badge.backgroundColor = NSColor.clear.cgColor
            badge.borderColor = Palette.faint.cgColor
            number.opacity = 0
            check.strokeEnd = 0
            titleLabel.textColor = Palette.faint
            detail.textColor = NSColor(white: 0.4, alpha: 1)
        }
        CATransaction.commit()
        guard animated else { return }
        if state == .done {
            let draw = CABasicAnimation(keyPath: "strokeEnd")
            draw.fromValue = 0
            draw.toValue = 1
            draw.duration = 0.32
            draw.timingFunction = CAMediaTimingFunction(name: .easeOut)
            check.add(draw, forKey: "draw")
            let pop = CAKeyframeAnimation(keyPath: "transform.scale")
            pop.values = [1, 1.3, 1]
            pop.keyTimes = [0, 0.4, 1]
            pop.duration = 0.34
            badge.add(pop, forKey: "pop")
        }
    }
}
