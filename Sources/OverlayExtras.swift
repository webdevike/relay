import Cocoa
import QuartzCore

extension Marks {
    /// Dotted trail drawn along Buddy's glide, then fading: shows where Buddy "moved the mouse".
    static func trail(_ path: CGPath, duration: CFTimeInterval, scale: CGFloat) -> CALayer {
        let line = CAShapeLayer()
        line.path = path
        line.fillColor = NSColor.clear.cgColor
        line.strokeColor = NSColor.white.withAlphaComponent(0.85).cgColor
        line.lineWidth = 3
        line.lineCap = .round
        line.lineDashPattern = [0.1, 9]
        line.shadowColor = Palette.deepBlue.cgColor
        line.shadowOpacity = 0.9
        line.shadowRadius = 2
        line.shadowOffset = .zero
        line.contentsScale = scale

        let draw = CABasicAnimation(keyPath: "strokeEnd")
        draw.fromValue = 0
        draw.toValue = 1
        draw.duration = duration
        draw.timingFunction = BuddyCharacter.glideTiming
        line.add(draw, forKey: "draw")

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        fade.beginTime = CACurrentMediaTime() + duration + 0.5
        fade.duration = 0.8
        fade.fillMode = .forwards
        fade.isRemovedOnCompletion = false
        line.add(fade, forKey: "fade")
        return line
    }

    /// A click: a dot that presses in, then a white ring that bursts out.
    static func click(at center: CGPoint, scale: CGFloat) -> CALayer {
        let container = CALayer()
        container.position = center
        container.bounds = CGRect(x: -30, y: -30, width: 60, height: 60)
        container.contentsScale = scale

        let dot = CAShapeLayer()
        dot.path = CGPath(ellipseIn: CGRect(x: -7, y: -7, width: 14, height: 14), transform: nil)
        dot.fillColor = Palette.blue.cgColor
        dot.strokeColor = NSColor.white.cgColor
        dot.lineWidth = 2
        dot.contentsScale = scale
        let press = CAKeyframeAnimation(keyPath: "transform.scale")
        press.values = [1.6, 0.7, 1]
        press.keyTimes = [0, 0.4, 1]
        press.duration = 0.3
        dot.add(press, forKey: "press")
        container.addSublayer(dot)

        let burst = CAShapeLayer()
        burst.path = CGPath(ellipseIn: CGRect(x: -10, y: -10, width: 20, height: 20), transform: nil)
        burst.fillColor = NSColor.clear.cgColor
        burst.strokeColor = NSColor.white.cgColor
        burst.lineWidth = 2.5
        burst.opacity = 0
        burst.contentsScale = scale
        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 0.6
        grow.toValue = 2.8
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [grow, fade]
        group.duration = 0.6
        group.beginTime = CACurrentMediaTime() + 0.1
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        burst.add(group, forKey: "burst")
        container.addSublayer(burst)
        return container
    }

    /// Small capsule with text, e.g. the lesson step pill.
    static func pill(_ text: String, scale: CGFloat) -> CALayer {
        let font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        let width = ceil((text as NSString).size(withAttributes: [.font: font]).width) + 24
        let layer = CALayer()
        layer.anchorPoint = .zero
        layer.bounds = CGRect(x: 0, y: 0, width: width, height: 24)
        layer.cornerRadius = 12
        layer.backgroundColor = Palette.panel.cgColor
        layer.borderColor = Palette.blue.cgColor
        layer.borderWidth = 1.5
        layer.contentsScale = scale
        let label = CATextLayer()
        label.string = text
        label.font = font
        label.fontSize = font.pointSize
        label.foregroundColor = NSColor.white.cgColor
        label.alignmentMode = .center
        label.contentsScale = scale
        label.frame = CGRect(x: 0, y: 4, width: width, height: 16)
        layer.addSublayer(label)
        let appear = CABasicAnimation(keyPath: "opacity")
        appear.fromValue = 0
        appear.toValue = 1
        appear.duration = 0.2
        layer.add(appear, forKey: "appear")
        return layer
    }
}

/// The Undo pill: a tiny clickable panel (the overlay itself is click-through). It never
/// activates Buddy, so the app being learned keeps focus.
@MainActor
final class UndoPill {
    private let panel: NSPanel
    private let button = NSButton()
    private var action: (() -> Void)?

    var isVisible: Bool { panel.isVisible && panel.alphaValue > 0.01 }
    var frame: CGRect { panel.frame }

    init() {
        panel = NSPanel(contentRect: CGRect(x: 0, y: 0, width: 120, height: 26),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.assistiveTechHighWindow)) + 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        let view = NSView(frame: panel.contentRect(forFrameRect: panel.frame))
        view.wantsLayer = true
        view.layer?.backgroundColor = Palette.deepBlue.cgColor
        view.layer?.cornerRadius = 13
        view.layer?.borderColor = NSColor.white.withAlphaComponent(0.75).cgColor
        view.layer?.borderWidth = 1
        button.isBordered = false
        button.target = self
        button.action = #selector(clicked)
        view.addSubview(button)
        panel.contentView = view
    }

    func configure(title: String, action: @escaping () -> Void) {
        self.action = action
        let text = "↩ Undo  ·  \(title)"
        let font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        button.attributedTitle = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: NSColor.white])
        let width = ceil((text as NSString).size(withAttributes: [.font: font]).width) + 26
        panel.setContentSize(CGSize(width: width, height: 26))
        panel.contentView?.frame = CGRect(x: 0, y: 0, width: width, height: 26)
        button.frame = CGRect(x: 0, y: 0, width: width, height: 26)
    }

    func setFrameOrigin(_ origin: CGPoint) { panel.setFrameOrigin(origin) }

    func show() {
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { $0.duration = 0.18; panel.animator().alphaValue = 1 }
    }

    func hide(duration: TimeInterval) {
        guard panel.isVisible else { return }
        NSAnimationContext.runAnimationGroup({ $0.duration = duration; panel.animator().alphaValue = 0 }) { [panel] in
            MainActor.assumeIsolated { if panel.alphaValue < 0.01 { panel.orderOut(nil) } }
        }
    }

    func trigger() { clicked() }

    @objc private func clicked() {
        let run = action
        action = nil
        run?()
    }
}
