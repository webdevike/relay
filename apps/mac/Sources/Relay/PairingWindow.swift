// A small floating panel showing the pairing PIN. SwiftUI's `Window` scene has no floating-level
// modifier, so this hosts the SwiftUI content in a plain NSWindow instead (see Input/README.md's
// note on TCC identity for the parallel reasoning on why the app-level primitives matter here).

import AppKit
import SwiftUI

@MainActor
final class PairingWindowController {
    private var window: NSWindow?

    func show(deviceName: String, pin: String, onCancel: @escaping () -> Void) {
        let content = PairingView(deviceName: deviceName, pin: pin, onCancel: onCancel)
        if let window {
            window.contentView = NSHostingView(rootView: content)
        } else {
            let panel = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 320, height: 260),
                styleMask: [.titled, .closable, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )
            panel.contentView = NSHostingView(rootView: content)
            panel.title = "Relay Pairing"
            panel.titleVisibility = .hidden
            panel.titlebarAppearsTransparent = true
            panel.isMovableByWindowBackground = true
            panel.level = .floating
            panel.isReleasedWhenClosed = false
            panel.standardWindowButton(.zoomButton)?.isHidden = true
            panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
            window = panel
        }
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func hide() {
        window?.orderOut(nil)
    }
}

struct PairingView: View {
    let deviceName: String
    let pin: String
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Text("Pair \u{201C}\(deviceName)\u{201D}")
                .font(.system(size: 15, weight: .semibold))
            Text(pin)
                .font(.system(size: 48, weight: .bold, design: .monospaced))
                .tracking(8)
                .monospacedDigit()
            Text("Enter this code on your iPhone")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Button("Cancel", action: onCancel)
                .keyboardShortcut(.cancelAction)
        }
        .padding(24)
        .frame(width: 320, height: 260)
    }
}
