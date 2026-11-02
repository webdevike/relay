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

    static let size = CGSize(width: 440, height: 134)

    init(appName: String) {
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
        buildContent(appName: appName)
    }

    private func buildContent(appName: String) {
        let surface = DragSurface(frame: CGRect(origin: .zero, size: Self.size))
        surface.wantsLayer = true
        surface.layer?.backgroundColor = Palette.panel.cgColor
        surface.layer?.cornerRadius = 14
        surface.layer?.masksToBounds = true
        surface.layer?.borderWidth = 1
        surface.layer?.borderColor = NSColor.white.withAlphaComponent(0.12).cgColor
        panel.contentView = surface

        let dot = NSView(frame: CGRect(x: 18, y: 107, width: 8, height: 8))
        dot.wantsLayer = true
        dot.layer?.backgroundColor = Palette.blue.cgColor
        dot.layer?.cornerRadius = 4
        surface.addSubview(dot)

        let title = NSTextField(labelWithAttributedString: {
            let s = NSMutableAttributedString(string: "Buddy", attributes: [
                .font: NSFont.systemFont(ofSize: 13, weight: .semibold), .foregroundColor: NSColor.white])
            s.append(NSAttributedString(string: "   Ask about \(appName)", attributes: [
                .font: NSFont.systemFont(ofSize: 13), .foregroundColor: Palette.muted]))
            return s
        }())
        title.frame = CGRect(x: 32, y: 102, width: 360, height: 18)
        surface.addSubview(title)

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
        ask.bezelColor = Palette.blue
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
