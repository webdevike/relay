// AXIsProcessTrusted(WithOptions) wrapper; never cached, TCC grants can change live.

import ApplicationServices

public final class SystemAccessibility: AccessibilityChecking {
    public init() {}

    public var isTrusted: Bool {
        AXIsProcessTrusted()
    }

    public func requestAccess() {
        let options: NSDictionary = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as NSString: true]
        _ = AXIsProcessTrustedWithOptions(options)
    }
}
