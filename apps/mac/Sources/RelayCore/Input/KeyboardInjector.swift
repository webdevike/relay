// Types into whatever has keyboard focus on the Mac via unicode-string key events. Never uses
// the pasteboard: the focused app sees keystrokes, not a paste.

import RelayProtocol

public final class KeyboardInjector: TextInjecting {
    /// CGEvent posts a unicode string per key event; keep chunks well under any single field's
    /// practical limit and small enough that a slow consumer app never sees a giant paste-like burst.
    static let maxChunkUTF16Units = 20

    private static let keyCodes: [KeyName: UInt16] = [
        .return: 36,
        .escape: 53,
        .backspace: 51,
        .tab: 48,
    ]

    private let poster: CGEventPoster
    private let accessibility: AccessibilityChecking

    public init(poster: CGEventPoster, accessibility: AccessibilityChecking) {
        self.poster = poster
        self.accessibility = accessibility
    }

    public func insert(_ text: String) throws {
        try requireTrusted()
        var buffer: [UInt16] = []
        buffer.reserveCapacity(KeyboardInjector.maxChunkUTF16Units)

        func flush() {
            guard !buffer.isEmpty else { return }
            poster.typeUnicode(buffer)
            buffer.removeAll(keepingCapacity: true)
        }

        for unit in text.utf16 {
            if unit == 0x0A {
                flush()
                poster.pressKey(KeyboardInjector.keyCodes[.return]!)
                continue
            }
            buffer.append(unit)
            if buffer.count == KeyboardInjector.maxChunkUTF16Units {
                // Never end a chunk on a high surrogate: that would split a surrogate pair
                // across two typeUnicode() posts. Back the surrogate off into the next chunk.
                if let last = buffer.last, (0xD800...0xDBFF).contains(last) {
                    buffer.removeLast()
                    flush()
                    buffer.append(last)
                } else {
                    flush()
                }
            }
        }
        flush()
    }

    public func press(_ key: KeyName) throws {
        try requireTrusted()
        poster.pressKey(KeyboardInjector.keyCodes[key]!)
    }

    private func requireTrusted() throws {
        guard accessibility.isTrusted else {
            throw AckError(code: .accessibilityDenied, message: "Accessibility permission is required to type on this Mac.")
        }
    }
}
