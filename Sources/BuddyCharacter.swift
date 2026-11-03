import Cocoa
import QuartzCore

/// The assistant's cursor: a teardrop in her accent colour carrying her avatar, a name tag and a
/// one-line caption. `root` sits exactly on the tip (the hotspot); everything else hangs below-right of it.
@MainActor
final class BuddyCharacter {
    let root = CALayer()
    private let body = CALayer()
    private let shape = CAShapeLayer()
    private let eyes = CALayer()
    private let pupils: [CALayer] = [CALayer(), CALayer()]
    private let mouth = CAShapeLayer()
    private let avatarLayer = CALayer()
    private var name = "Relay Assist"
    private let tag = CALayer()
    private let tagText = CATextLayer()
    private let caption = CALayer()
    private let captionText = CATextLayer()

    private var thinkingTimer: Timer?
    private var thinkingBase = ""
    private var staying = false

    private static let center = CGPoint(x: 21, y: -21)
    private static let radius: CGFloat = 17
    private static let tagFont = NSFont.systemFont(ofSize: 11, weight: .semibold)
    private static let captionFont = NSFont.systemFont(ofSize: 13, weight: .medium)
    private static let maxCaptionWidth: CGFloat = 600

    init() {
        root.bounds = .zero
        root.anchorPoint = .zero
        root.masksToBounds = false

        body.bounds = .zero
        body.anchorPoint = .zero
        root.addSublayer(body)

        shape.path = Self.teardrop()
        shape.fillColor = Palette.accent.cgColor
        shape.strokeColor = NSColor.white.cgColor
        shape.lineWidth = 2
        shape.lineJoin = .round
        shape.shadowColor = NSColor.black.cgColor
        shape.shadowOpacity = 0.35
        shape.shadowRadius = 4
        shape.shadowOffset = CGSize(width: 0, height: -1.5)
        body.addSublayer(shape)

        let c = Self.center
        eyes.frame = CGRect(x: c.x - 7, y: c.y - 2, width: 14, height: 8)
        for (index, x) in [CGFloat(1), 8].enumerated() {
            let white = CALayer()
            white.frame = CGRect(x: x, y: 0, width: 5, height: 6.5)
            white.cornerRadius = 2.5
            white.backgroundColor = NSColor.white.cgColor
            let pupil = pupils[index]
            pupil.bounds = CGRect(x: 0, y: 0, width: 2.8, height: 3.2)
            pupil.cornerRadius = 1.4
            pupil.backgroundColor = Palette.ink.cgColor
            pupil.position = CGPoint(x: 2.5, y: 3.2)
            white.addSublayer(pupil)
            eyes.addSublayer(white)
        }
        body.addSublayer(eyes)

        let smile = CGMutablePath()
        smile.addArc(center: CGPoint(x: c.x + 0.5, y: c.y - 2.5), radius: 3.6,
                     startAngle: .pi * 1.18, endAngle: .pi * 1.82, clockwise: false)
        mouth.path = smile
        mouth.strokeColor = NSColor.white.cgColor
        mouth.fillColor = NSColor.clear.cgColor
        mouth.lineWidth = 1.5
        mouth.lineCap = .round
        body.addSublayer(mouth)
        let r = Self.radius
        avatarLayer.frame = CGRect(x: c.x - r + 1.5, y: c.y - r + 1.5, width: 2 * r - 3, height: 2 * r - 3)
        avatarLayer.cornerRadius = r - 1.5
        avatarLayer.masksToBounds = true
        avatarLayer.contentsGravity = .resizeAspectFill
        avatarLayer.isHidden = true
        body.addSublayer(avatarLayer)
        tag.anchorPoint = .zero
        caption.anchorPoint = .zero

        tag.backgroundColor = Palette.deepAccent.cgColor
        tag.cornerRadius = 9
        tag.borderColor = NSColor.white.withAlphaComponent(0.7).cgColor
        tag.borderWidth = 1
        tagText.font = Self.tagFont
        tagText.fontSize = Self.tagFont.pointSize
        tagText.foregroundColor = NSColor.white.cgColor
        tagText.alignmentMode = .center
        tag.addSublayer(tagText)
        root.addSublayer(tag)

        // One quiet line: a soft dark backdrop for legibility, no border.
        caption.backgroundColor = Palette.panel.withAlphaComponent(0.88).cgColor
        caption.cornerRadius = 8
        caption.shadowColor = NSColor.black.cgColor
        caption.shadowOpacity = 0.2
        caption.shadowRadius = 4
        caption.shadowOffset = CGSize(width: 0, height: -1)
        captionText.font = Self.captionFont
        captionText.fontSize = Self.captionFont.pointSize
        captionText.foregroundColor = NSColor.white.cgColor
        captionText.truncationMode = .end
        captionText.isWrapped = false
        caption.addSublayer(captionText)
        root.addSublayer(caption)

        setTagText(name)
        startBlinking()
    }

    /// Teardrop: a circle with its point at (0, 0), aimed up-left like a cursor.
    private static func teardrop() -> CGPath {
        let c = center, r = radius
        let toTip = CGPoint(x: -c.x, y: -c.y)
        let d = hypot(toTip.x, toTip.y)
        let theta = atan2(toTip.y, toTip.x)
        let alpha = acos(r / d)
        let path = CGMutablePath()
        path.move(to: .zero)
        path.addLine(to: CGPoint(x: c.x + r * cos(theta + alpha), y: c.y + r * sin(theta + alpha)))
        path.addArc(center: c, radius: r, startAngle: theta + alpha, endAngle: theta - alpha + 2 * .pi, clockwise: false)
        path.closeSubpath()
        return path
    }

    func setContentsScale(_ scale: CGFloat) {
        for layer in [root, body, shape, mouth, avatarLayer, tag, tagText, caption, captionText] { layer.contentsScale = scale }
    }

    /// Who is answering: her name on the tag, her accent on the body and tag, her avatar in the head
    /// (the drawn face stays only while the avatar has not been drawn yet). `animated` (Buddy on screen and
    /// the answer moved to the other assistant): crossfade and pop the head and tag instead of a hard swap.
    func setIdentity(name: String, accent: NSColor, avatar: NSImage?, animated: Bool = false) {
        let changed = name != self.name
        self.name = name
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if animated, changed {
            let fade = CATransition()
            fade.type = .fade
            fade.duration = 0.3
            for layer in [avatarLayer, shape, tag, tagText] { layer.add(fade, forKey: "identity") }
            let pop = CAKeyframeAnimation(keyPath: "transform.scale")
            pop.values = [1, 0.72, 1.15, 1]
            pop.keyTimes = [0, 0.35, 0.75, 1]
            pop.duration = 0.36
            body.add(pop, forKey: "identity-pop")
        }
        shape.fillColor = accent.cgColor
        tag.backgroundColor = (accent.blended(withFraction: 0.18, of: .black) ?? accent).cgColor
        avatarLayer.contents = avatar?.cgImage(forProposedRect: nil, context: nil, hints: nil)
        avatarLayer.isHidden = avatar == nil
        eyes.isHidden = avatar != nil
        mouth.isHidden = avatar != nil
        CATransaction.commit()
        setTagText(staying ? "\(name) · staying" : name)
    }

    func setStaying(_ stay: Bool) {
        staying = stay
        setTagText(stay ? "\(name) · staying" : name)
    }

    /// The name tag shows only while she is staying; her avatar in the head already says who she is.
    private func setTagText(_ text: String) {
        let width = ceil((text as NSString).size(withAttributes: [.font: Self.tagFont]).width) + 16
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        tag.bounds = CGRect(x: 0, y: 0, width: width, height: 18)
        tagText.string = text
        tagText.frame = CGRect(x: 0, y: 2, width: width, height: 14)
        tag.isHidden = !staying
        CATransaction.commit()
    }

    func setThinking(_ thinking: Bool, text: String) {
        thinkingTimer?.invalidate()
        thinkingTimer = nil
        body.removeAnimation(forKey: "bob")
        if thinking {
            thinkingBase = text
            var dots = 0
            setCaption(text + "   ")
            thinkingTimer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    dots = (dots + 1) % 4
                    self.setCaption(self.thinkingBase + String(repeating: ".", count: dots) + String(repeating: " ", count: 3 - dots))
                }
            }
            let bob = CABasicAnimation(keyPath: "transform.translation.y")
            bob.fromValue = -1.5
            bob.toValue = 1.5
            bob.duration = 0.55
            bob.autoreverses = true
            bob.repeatCount = .infinity
            bob.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            body.add(bob, forKey: "bob")
        } else {
            setCaption(text)
        }
    }

    private func setCaption(_ text: String) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        caption.isHidden = text.isEmpty
        captionText.string = text
        let measured = ceil((text as NSString).size(withAttributes: [.font: Self.captionFont]).width)
        if measured <= Self.maxCaptionWidth && !text.contains("\n") {
            captionText.isWrapped = false
            let width = measured + 22
            caption.bounds = CGRect(x: 0, y: 0, width: width, height: 26)
            captionText.frame = CGRect(x: 11, y: 4, width: width - 22, height: 18)
        } else {
            // A longer explanation: wrap inside the max width and grow the bubble taller.
            captionText.isWrapped = true
            let textWidth = Self.maxCaptionWidth
            let box = (text as NSString).boundingRect(
                with: CGSize(width: textWidth, height: 2000),
                options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: Self.captionFont])
            let height = ceil(box.height) + 4
            caption.bounds = CGRect(x: 0, y: 0, width: textWidth + 22, height: height + 12)
            captionText.frame = CGRect(x: 11, y: 6, width: textWidth, height: height)
        }
        CATransaction.commit()
    }

    /// True while the caption is taller than the one-line bubble.
    var captionIsTall: Bool { caption.bounds.height > 30 }

    /// Places tag and caption below-right of the tip, kept inside `bounds` (overlay-local).
    func layoutLabels(tip: CGPoint, in bounds: CGRect) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let extra = max(0, caption.bounds.height - 26)
        let below = tip.y - 98 - extra > bounds.minY + 8
        let room: CGFloat = tag.isHidden ? 0 : 30
        var tagOrigin = CGPoint(x: 42, y: below ? -64 : 12)
        var captionOrigin = CGPoint(x: 42, y: below ? -64 - room - extra : 12 + room)
        let overflowTag = tip.x + tagOrigin.x + tag.bounds.width - (bounds.maxX - 8)
        if overflowTag > 0 { tagOrigin.x -= overflowTag }
        let overflowCaption = tip.x + captionOrigin.x + caption.bounds.width - (bounds.maxX - 8)
        if overflowCaption > 0 { captionOrigin.x -= overflowCaption }
        tag.frame = CGRect(origin: tagOrigin, size: tag.bounds.size)
        caption.frame = CGRect(origin: captionOrigin, size: caption.bounds.size)
        CATransaction.commit()
    }

    func look(toward direction: CGPoint) {
        let length = max(1, hypot(direction.x, direction.y))
        let offset = CGPoint(x: direction.x / length * 1.1, y: direction.y / length * 1.3)
        for pupil in pupils { pupil.position = CGPoint(x: 2.5 + offset.x, y: 3.2 + offset.y) }
    }

    func appear() {
        let pop = CASpringAnimation(keyPath: "transform.scale")
        pop.fromValue = 0.4
        pop.toValue = 1
        pop.damping = 12
        pop.initialVelocity = 8
        pop.duration = pop.settlingDuration
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        fade.duration = 0.15
        root.add(pop, forKey: "appear")
        root.add(fade, forKey: "appearFade")
    }

    /// Caption bubble frame relative to the tip (root sits on the tip with a zero-size bounds).
    var captionFrame: CGRect { caption.isHidden ? .zero : caption.frame }

    /// Smooth curved glide, like a person moving their mouse, easing into the target.
    /// Returns the path it follows (overlay-local), for drawing a trail along it.
    static let glideTiming = CAMediaTimingFunction(controlPoints: 0.35, 0.0, 0.15, 1.0)

    @discardableResult
    func glide(from start: CGPoint, to end: CGPoint, duration: CFTimeInterval, completion: @escaping @MainActor () -> Void) -> CGPath? {
        let current = root.presentation()?.position ?? start
        let dx = end.x - current.x, dy = end.y - current.y
        let distance = hypot(dx, dy)
        var path: CGMutablePath?
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        CATransaction.setCompletionBlock { MainActor.assumeIsolated { completion() } }
        if distance > 1 {
            let bend = min(80, distance * 0.12)
            let mid = CGPoint(x: (current.x + end.x) / 2, y: (current.y + end.y) / 2)
            let control = CGPoint(x: mid.x - dy / distance * bend, y: mid.y + dx / distance * bend)
            let curve = CGMutablePath()
            curve.move(to: current)
            curve.addQuadCurve(to: end, control: control)
            let move = CAKeyframeAnimation(keyPath: "position")
            move.path = curve
            move.duration = duration
            move.timingFunction = Self.glideTiming
            root.add(move, forKey: "glide")
            path = curve
        }
        root.position = end
        CATransaction.commit()
        return path
    }

    /// Small squash on arrival.
    func land() {
        let squash = CAKeyframeAnimation(keyPath: "transform.scale")
        squash.values = [1, 1.14, 0.96, 1]
        squash.keyTimes = [0, 0.35, 0.7, 1]
        squash.duration = 0.32
        body.add(squash, forKey: "land")
    }

    private func startBlinking() {
        let blink = CAKeyframeAnimation(keyPath: "transform.scale.y")
        blink.values = [1, 1, 0.1, 1]
        blink.keyTimes = [0, 0.93, 0.965, 1]
        blink.duration = 3.6
        blink.repeatCount = .infinity
        eyes.add(blink, forKey: "blink")
    }
}
