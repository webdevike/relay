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
    private var title: NSTextField?
    private let appName: String

    static let size = CGSize(width: 440, height: 134)

    init(appName: String, assistant: Assistant) {
        self.assistant = assistant
        self.appName = appName
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
        buildContent(appName: appName, assistant: assistant)
    }

    private func buildContent(appName: String, assistant: Assistant) {
        let surface = DragSurface(frame: CGRect(origin: .zero, size: Self.size))
        surface.wantsLayer = true
        surface.layer?.backgroundColor = Palette.panel.cgColor
        surface.layer?.cornerRadius = 14
        surface.layer?.masksToBounds = true
        surface.layer?.borderWidth = 1
        surface.layer?.borderColor = NSColor.white.withAlphaComponent(0.12).cgColor
        panel.contentView = surface

        let faceView = NSView(frame: CGRect(x: 12, y: 99, width: 24, height: 24))
        faceView.wantsLayer = true
        face.frame = faceView.bounds
        face.cornerRadius = 12
        face.masksToBounds = true
        face.contentsGravity = .resizeAspectFill
        faceView.layer?.addSublayer(face)
        surface.addSubview(faceView)

        let title = NSTextField(labelWithString: "")
        title.frame = CGRect(x: 42, y: 102, width: 350, height: 18)
        title.wantsLayer = true
        surface.addSubview(title)
        self.title = title
        paintIdentity()
        buildRest(in: surface)
    }

    private func paintIdentity() {
        face.backgroundColor = assistant.accent.cgColor
        face.contents = Assistants.avatar(for: assistant)?.cgImage(forProposedRect: nil, context: nil, hints: nil)
        let s = NSMutableAttributedString(string: assistant.title, attributes: [
            .font: NSFont.systemFont(ofSize: 13, weight: .semibold), .foregroundColor: assistant.accent])
        s.append(NSAttributedString(string: "   Ask about \(appName)", attributes: [
            .font: NSFont.systemFont(ofSize: 13), .foregroundColor: Palette.muted]))
        title?.attributedStringValue = s
    }

    /// The typed words route to someone else ("Astra, ...", an issue key): crossfade and pop the avatar and
    /// name to her before Return, so nothing flips after the question is sent.
    func setAssistant(_ next: Assistant) {
        guard next.id != assistant.id else { return }
        Log.info("bubble: \(assistant.title) -> \(next.title) while typing")
        assistant = next
        let fade = CATransition()
        fade.type = .fade
        fade.duration = 0.25
        face.add(fade, forKey: "identity")
        title?.layer?.add(fade, forKey: "identity")
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
        let close = NSButton(title: "✕", target: self, action: #selector(closeClicked))
        close.isBordered = false
        close.font = .systemFont(ofSize: 12, weight: .medium)
        close.contentTintColor = Palette.muted
        close.frame = CGRect(x: Self.size.width - 34, y: 100, width: 22, height: 22)
        close.toolTip = "Close (Esc)"
        surface.addSubview(close)

        field.frame = CGRect(x: 16, y: 56, width: Self.size.width - 32, height: 30)
        field.isBordered = false
        field.isBezeled = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = .systemFont(ofSize: 19)
        field.textColor = .white
        field.placeholderAttributedString = NSAttributedString(string: "Where is the bevel tool?", attributes: [
            .font: NSFont.systemFont(ofSize: 19), .foregroundColor: Palette.faint])
        field.cell?.usesSingleLineMode = true
        field.cell?.lineBreakMode = .byTruncatingHead
        field.delegate = self
        field.target = self
        field.action = #selector(submitClicked)
        surface.addSubview(field)

        let divider = NSView(frame: CGRect(x: 0, y: 46, width: Self.size.width, height: 1))
        divider.wantsLayer = true
        divider.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.08).cgColor
        surface.addSubview(divider)

        let footer = NSTextField(labelWithString: "Active window only  ·  Screenshot + accessibility  ·  Esc closes")
        footer.font = .systemFont(ofSize: 11)
        footer.textColor = Palette.faint
        footer.frame = CGRect(x: 18, y: 15, width: 330, height: 16)
        surface.addSubview(footer)

        let ask = NSButton(title: "Ask", target: self, action: #selector(submitClicked))
        ask.bezelStyle = .rounded
        ask.bezelColor = Palette.accent
        ask.frame = CGRect(x: Self.size.width - 78, y: 9, width: 64, height: 28)
        surface.addSubview(ask)
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

    @objc private func closeClicked() { close() }

    /// Hold-to-talk: the placeholder says Buddy is listening; the live transcript fills the field.
    func setListening(_ listening: Bool) {
        let text = listening ? "Listening..." : "Where is the bevel tool?"
        field.placeholderAttributedString = NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: 19), .foregroundColor: listening ? Palette.accent : Palette.faint])
    }

    func showTranscript(_ text: String) { field.stringValue = text }

    /// A lesson is running: hint the bubble's lesson words.
    func setLessonHint(_ hint: String?) {
        guard let hint else { return }
        field.placeholderAttributedString = NSAttributedString(string: hint, attributes: [
            .font: NSFont.systemFont(ofSize: 19), .foregroundColor: Palette.faint])
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
