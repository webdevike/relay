import Cocoa
import QuartzCore

/// The lesson's step list: a small dark panel with every step, the current one highlighted in the
/// assistant's accent, finished ones checked off. Non-activating (the app being learned keeps focus),
/// mouse-transparent except over its header (drag) and its Skip / Stop buttons, and it remembers
/// where Isaac dragged it.
@MainActor
final class LessonChecklist {
    enum State { case pending, current, done, skipped }

    var onSkip: (() -> Void)?
    var onStop: (() -> Void)?
    private(set) var isVisible = false

    private static let width: CGFloat = 332
    private static let headerHeight: CGFloat = 58
    private static let rowHeight: CGFloat = 46
    private static let footerHeight: CGFloat = 42
    private static let defaultsKey = "lessonChecklistOrigin"

    private var panel: NSPanel?
    private var root: ChecklistRoot?
    private var rows: [ChecklistRow] = []
    private var states: [State] = []
    private var headline: NSTextField?
    private var closeWork: DispatchWorkItem?
    private var monitors: [Any] = []
    private var placing = false
    private var moveObserver: NSObjectProtocol?

    // MARK: Public

    /// Shows the list for a new lesson on the screen holding `windowFrame` (global CoreGraphics coordinates).
    func show(assistant: Assistant, goal: String, steps: [LessonStep], windowFrame: CGRect?) {
        close(animated: false)
        let height = Self.headerHeight + Self.rowHeight * CGFloat(steps.count) + Self.footerHeight
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
        root.layer?.borderWidth = 1
        root.layer?.borderColor = NSColor.white.withAlphaComponent(0.12).cgColor
        root.dragRect = CGRect(x: 0, y: 0, width: size.width, height: Self.headerHeight)
        panel.contentView = root
        self.root = root

        buildHeader(in: root, assistant: assistant, goal: goal)
        states = Array(repeating: .pending, count: steps.count)
        rows = steps.enumerated().map { index, step in
            let row = ChecklistRow(number: index + 1, title: step.title, instruction: step.instruction,
                                   frame: CGRect(x: 0, y: Self.headerHeight + Self.rowHeight * CGFloat(index),
                                                 width: size.width, height: Self.rowHeight))
            root.addSubview(row)
            return row
        }
        buildFooter(in: root, y: size.height - Self.footerHeight, accent: assistant.accent)

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
    }

    func markDone(_ i: Int) {
        guard states.indices.contains(i) else { return }
        states[i] = .done
        rows[i].set(.done, animated: true)
    }

    func markSkipped(_ i: Int) {
        guard states.indices.contains(i) else { return }
        states[i] = .skipped
        rows[i].set(.skipped, animated: true)
    }

    /// Every step handled: "Done! ✓", a small burst, and the panel closes itself after about 4 s.
    func celebrate(goal: String, accent: NSColor) {
        guard let root, let panel else { return }
        headline?.stringValue = "Done! ✓"
        headline?.textColor = accent
        root.showDoneFooter("Nice work: \(goal)")
        burst(in: root, accent: accent)
        let work = DispatchWorkItem { [weak self] in self?.close(animated: true) }
        closeWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: work)
        _ = panel
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

    private func buildHeader(in root: NSView, assistant: Assistant, goal: String) {
        let avatar = NSView(frame: CGRect(x: 14, y: 14, width: 30, height: 30))
        avatar.wantsLayer = true
        avatar.layer?.cornerRadius = 15
        avatar.layer?.masksToBounds = true
        avatar.layer?.backgroundColor = assistant.accent.cgColor
        if let image = Assistants.avatar(for: assistant) {
            avatar.layer?.contents = image
            avatar.layer?.contentsGravity = .resizeAspectFill
        }
        root.addSubview(avatar)

        let name = NSTextField(labelWithString: "\(assistant.title)  ·  Lesson")
        name.font = .systemFont(ofSize: 11, weight: .semibold)
        name.textColor = assistant.accent
        name.frame = CGRect(x: 54, y: 11, width: Self.width - 68, height: 15)
        root.addSubview(name)

        let title = NSTextField(labelWithString: goal.prefix(1).uppercased() + goal.dropFirst())
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.textColor = .white
        title.lineBreakMode = .byTruncatingTail
        title.frame = CGRect(x: 54, y: 27, width: Self.width - 68, height: 20)
        root.addSubview(title)
        headline = title
    }

    private func buildFooter(in root: ChecklistRoot, y: CGFloat, accent: NSColor) {
        let line = NSView(frame: CGRect(x: 14, y: y, width: Self.width - 28, height: 1))
        line.wantsLayer = true
        line.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.08).cgColor
        root.addSubview(line)

        let hint = NSTextField(labelWithString: "Esc stops")
        hint.font = .systemFont(ofSize: 11)
        hint.textColor = Palette.faint
        hint.frame = CGRect(x: 16, y: y + 14, width: 90, height: 14)
        root.addSubview(hint)
        root.footerViews.append(hint)

        let stop = footerButton("Stop", x: Self.width - 14 - 52, y: y + 8, action: #selector(stopClicked))
        let skip = footerButton("Skip", x: Self.width - 14 - 52 - 8 - 52, y: y + 8, action: #selector(skipClicked))
        for button in [skip, stop] {
            root.addSubview(button)
            root.buttons.append(button)
            root.footerViews.append(button)
        }
    }

    private func footerButton(_ title: String, x: CGFloat, y: CGFloat, action: Selector) -> NSButton {
        let button = ChecklistButton(frame: CGRect(x: x, y: y, width: 52, height: 26))
        button.isBordered = false
        button.wantsLayer = true
        button.layer?.cornerRadius = 8
        button.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.08).cgColor
        button.attributedTitle = NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: 12, weight: .medium), .foregroundColor: Palette.muted])
        button.target = self
        button.action = action
        return button
    }

    @objc private func skipClicked() { onSkip?() }
    @objc private func stopClicked() { onStop?() }

    // MARK: Placement

    /// Top-right of the screen holding the target window, inset from the edge, below the menu bar;
    /// a position Isaac dragged to wins when it is still on a screen.
    private func place(_ panel: NSPanel, size: CGSize, windowFrame: CGRect?) {
        placing = true
        defer { DispatchQueue.main.async { [weak self] in self?.placing = false } }
        if let saved = UserDefaults.standard.array(forKey: Self.defaultsKey) as? [Double], saved.count == 2 {
            let rect = CGRect(origin: CGPoint(x: saved[0], y: saved[1]), size: size)
            if NSScreen.screens.contains(where: { $0.visibleFrame.intersects(rect.insetBy(dx: 20, dy: 20)) }) {
                panel.setFrameOrigin(rect.origin)
                observeMoves(panel)
                return
            }
        }
        let screen = windowFrame.flatMap { frame -> NSScreen? in
            let ak = appKitRect(frame)
            return NSScreen.screens.max { $0.frame.intersection(ak).area < $1.frame.intersection(ak).area }
        } ?? NSScreen.main ?? NSScreen.screens[0]
        let visible = screen.visibleFrame
        panel.setFrameOrigin(CGPoint(x: visible.maxX - size.width - 16, y: visible.maxY - size.height - 16))
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
        if AXIsProcessTrusted(), let key = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: { [weak self] event in
            guard event.keyCode == 53 else { return } // Esc
            MainActor.assumeIsolated { self?.onStop?() }
        }) { monitors.append(key) }
    }

    private func removeMonitors() {
        monitors.forEach(NSEvent.removeMonitor)
        monitors.removeAll()
    }

    private func updateMousePassThrough() {
        guard let panel, let root else { return }
        // A drag in progress must keep receiving events.
        if NSEvent.pressedMouseButtons & 1 != 0, !panel.ignoresMouseEvents { return }
        let point = root.convert(panel.convertPoint(fromScreen: NSEvent.mouseLocation), from: nil)
        panel.ignoresMouseEvents = !root.interactive(at: point)
    }

    // MARK: Celebration

    private func burst(in view: NSView, accent: NSColor) {
        guard let layer = view.layer else { return }
        let emitter = CAEmitterLayer()
        emitter.frame = layer.bounds
        emitter.emitterPosition = CGPoint(x: layer.bounds.midX, y: 40)
        emitter.emitterShape = .line
        emitter.emitterSize = CGSize(width: layer.bounds.width * 0.7, height: 1)
        let dot = NSImage(size: CGSize(width: 8, height: 8), flipped: false) { rect in
            NSColor.white.setFill()
            NSBezierPath(roundedRect: rect, xRadius: 2, yRadius: 2).fill()
            return true
        }
        let colors: [NSColor] = [accent, .white, accent.blended(withFraction: 0.5, of: .white) ?? accent, NSColor(srgbRed: 0.32, green: 0.81, blue: 0.4, alpha: 1)]
        emitter.emitterCells = colors.map { color in
            let cell = CAEmitterCell()
            cell.contents = dot.cgImage(forProposedRect: nil, context: nil, hints: nil)
            cell.color = color.cgColor
            cell.birthRate = 14
            cell.lifetime = 1.6
            cell.velocity = 110
            cell.velocityRange = 50
            cell.emissionLongitude = .pi / 2   // layer is flipped: positive y is down
            cell.emissionRange = .pi / 3
            cell.yAcceleration = 90
            cell.spin = 3
            cell.spinRange = 4
            cell.scale = 0.7
            cell.scaleRange = 0.4
            cell.alphaSpeed = -0.6
            return cell
        }
        layer.addSublayer(emitter)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { emitter.birthRate = 0 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { emitter.removeFromSuperlayer() }
    }
}

private extension CGRect {
    var area: CGFloat { isNull ? 0 : width * height }
}

/// Flipped root view: y grows downward. Reports which points take the mouse.
private final class ChecklistRoot: NSView {
    var dragRect: CGRect = .zero
    var buttons: [NSButton] = []
    var footerViews: [NSView] = []
    private var doneLabel: NSTextField?

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { true }

    func interactive(at point: CGPoint) -> Bool {
        if dragRect.contains(point) { return true }
        return buttons.contains { !$0.isHidden && $0.frame.contains(point) }
    }

    func showDoneFooter(_ text: String) {
        footerViews.forEach { $0.isHidden = true }
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = Palette.muted
        label.lineBreakMode = .byTruncatingTail
        label.frame = CGRect(x: 16, y: bounds.height - 28, width: bounds.width - 32, height: 16)
        addSubview(label)
        doneLabel = label
    }
}

private final class ChecklistButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
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
