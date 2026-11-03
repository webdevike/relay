import Cocoa

/// Non-activating panel: it takes keystrokes while the app you are learning stays frontmost.
final class BubblePanel: NSPanel {
    var onCancel: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) { onCancel?() }
}

/// Drag the bubble from anywhere that isn't a control.
final class DragSurface: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
}

/// The small question bubble that opens beside the cursor.
@MainActor
final class PromptBubble: NSObject, NSTextFieldDelegate {
    var onSubmit: ((String) -> Void)?
    var onClose: (() -> Void)?

    private let panel: BubblePanel
    private let field = NSTextField()
    private var outsideClickMonitor: Any?
    private var closed = false
    /// Who would answer the text typed so far (AssistantRouter rules, screen part decided at summon).
    var router: ((String) -> Assistant)?
    private var assistant: Assistant
    private let face = CALayer()

    static let size = CGSize(width: 420, height: 48)

    /// Just a text field with the answering assistant's avatar as a small leading dot; Return asks, Esc closes.
    init(assistant: Assistant) {
        self.assistant = assistant
        panel = BubblePanel(contentRect: CGRect(origin: .zero, size: Self.size),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.level = .popUpMenu
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.onCancel = { [weak self] in self?.close() }
        buildContent()
    }

    private func buildContent() {
        let surface = DragSurface(frame: CGRect(origin: .zero, size: Self.size))
        surface.wantsLayer = true
        surface.layer?.backgroundColor = Palette.panel.cgColor
        surface.layer?.cornerRadius = Self.size.height / 2
        surface.layer?.masksToBounds = true
        panel.contentView = surface

        let faceView = NSView(frame: CGRect(x: 14, y: (Self.size.height - 22) / 2, width: 22, height: 22))
        faceView.wantsLayer = true
        face.frame = faceView.bounds
        face.cornerRadius = 11
        face.masksToBounds = true
        face.contentsGravity = .resizeAspectFill
        faceView.layer?.addSublayer(face)
        surface.addSubview(faceView)
        paintIdentity()
        buildRest(in: surface)
    }

    private func paintIdentity() {
        face.backgroundColor = assistant.accent.cgColor
        face.contents = Assistants.avatar(for: assistant)?.cgImage(forProposedRect: nil, context: nil, hints: nil)
    }

    /// The typed words route to someone else ("Astra, ...", an issue key): crossfade and pop the avatar
    /// to her before Return, so nothing flips after the question is sent.
    func setAssistant(_ next: Assistant) {
        guard next.id != assistant.id else { return }
        Log.info("bubble: \(assistant.title) -> \(next.title) while typing")
        assistant = next
        let fade = CATransition()
        fade.type = .fade
        fade.duration = 0.25
        face.add(fade, forKey: "identity")
        let pop = CAKeyframeAnimation(keyPath: "transform.scale")
        pop.values = [1, 0.7, 1.12, 1]
        pop.keyTimes = [0, 0.35, 0.75, 1]
        pop.duration = 0.32
        face.add(pop, forKey: "pop")
        paintIdentity()
    }

    func controlTextDidChange(_ obj: Notification) {
        if let router { setAssistant(router(field.stringValue)) }
    }

    private func buildRest(in surface: NSView) {
        field.frame = CGRect(x: 44, y: (Self.size.height - 28) / 2, width: Self.size.width - 58, height: 28)
        field.isBordered = false
        field.isBezeled = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = .systemFont(ofSize: 18)
        field.textColor = .white
        field.placeholderAttributedString = Self.placeholder("Ask anything", color: Palette.faint)
        field.cell?.usesSingleLineMode = true
        field.cell?.lineBreakMode = .byTruncatingHead
        field.delegate = self
        field.target = self
        field.action = #selector(submitClicked)
        surface.addSubview(field)
    }

    private static func placeholder(_ text: String, color: NSColor) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: 18), .foregroundColor: color])
    }

    /// Opens just below-right of the cursor, kept on the cursor's screen.
    func show(near cursor: CGPoint) {
        let screen = NSScreen.screens.first(where: { NSMouseInRect(cursor, $0.frame, false) }) ?? NSScreen.main!
        let visible = screen.visibleFrame
        var origin = CGPoint(x: cursor.x + 14, y: cursor.y - Self.size.height - 14)
        if origin.x + Self.size.width > visible.maxX - 8 { origin.x = cursor.x - Self.size.width - 14 }
        if origin.y < visible.minY + 8 { origin.y = cursor.y + 14 }
        origin.x = min(max(origin.x, visible.minX + 8), visible.maxX - Self.size.width - 8)
        origin.y = min(max(origin.y, visible.minY + 8), visible.maxY - Self.size.height - 8)
        panel.setFrameOrigin(origin)
        panel.alphaValue = 0
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            panel.animator().alphaValue = 1
        }
        outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }
    }

    func close() {
        guard !closed else { return }
        closed = true
        if let monitor = outsideClickMonitor { NSEvent.removeMonitor(monitor) }
        outsideClickMonitor = nil
        panel.orderOut(nil)
        onClose?()
    }

    /// Hold-to-talk: the placeholder says she is listening; the live transcript fills the field.
    func setListening(_ listening: Bool) {
        field.placeholderAttributedString = Self.placeholder(listening ? "Listening..." : "Ask anything",
                                                             color: listening ? assistant.accent : Palette.faint)
    }

    func showTranscript(_ text: String) { field.stringValue = text }

    /// A lesson is running: hint the bubble's lesson words.
    func setLessonHint(_ hint: String?) {
        guard let hint else { return }
        field.placeholderAttributedString = Self.placeholder(hint, color: Palette.faint)
    }

    @objc private func submitClicked() {
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !closed else { return }
        let submit = onSubmit
        close()
        submit?(text)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.cancelOperation(_:)) {
            close()
            return true
        }
        return false
    }
}
