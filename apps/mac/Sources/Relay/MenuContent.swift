// The `.menuBarExtraStyle(.window)` popover content: status, Accessibility, connected/paired
// devices, Quit. `.onAppear`/`.onDisappear` here double as "menu opened/closed" since SwiftUI
// mounts and unmounts this view with the popover for window-style menu bar extras.

import RelayCore
import SwiftUI

struct MenuContent: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            statusRow
            accessibilityRow
            if !model.connected.isEmpty {
                Divider()
                connectedSection
            }
            Divider()
            devicesSection
            Divider()
            Button("Quit Relay") {
                NSApplication.shared.terminate(nil)
            }
            .keyboardShortcut("q")
        }
        .padding(12)
        .frame(width: 280, alignment: .leading)
        .onAppear { model.menuWillAppear() }
        .onDisappear { model.menuWillDisappear() }
    }

    private var statusRow: some View {
        HStack(spacing: 6) {
            Circle().fill(statusColor).frame(width: 8, height: 8)
            Text(statusText)
                .font(.system(size: 13, weight: .medium))
            Spacer(minLength: 0)
        }
    }

    private var statusText: String {
        switch model.state {
        case .stopped: return "Stopped"
        case .starting: return "Starting"
        case let .listening(port): return "Listening on port \(port)"
        case let .failed(reason): return "Failed: \(reason)"
        }
    }

    private var statusColor: Color {
        switch model.state {
        case .listening: return .green
        case .starting: return .yellow
        case .stopped, .failed: return .red
        }
    }

    @ViewBuilder
    private var accessibilityRow: some View {
        if model.accessibilityGranted {
            HStack(spacing: 6) {
                Circle().fill(Color.green).frame(width: 6, height: 6)
                Text("Accessibility granted")
                    .font(.system(size: 12))
            }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text("Accessibility not granted")
                        .font(.system(size: 12))
                }
                Button("Open Accessibility Settings") {
                    model.requestAccessibilityAccess()
                }
                .font(.system(size: 12))
            }
        }
    }

    private var connectedSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Connected")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            ForEach(model.connected, id: \.deviceId) { device in
                HStack {
                    Text(device.deviceName.isEmpty ? device.deviceId : device.deviceName)
                        .font(.system(size: 12))
                    Spacer()
                    Text(device.connectedAt, style: .time)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var devicesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Paired devices")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            if model.devices.isEmpty {
                Text("No paired devices")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.devices, id: \.id) { device in
                    HStack {
                        Text(device.name)
                            .font(.system(size: 12))
                        Spacer()
                        Button("Forget") {
                            model.forget(deviceId: device.id)
                        }
                        .font(.system(size: 11))
                    }
                }
            }
        }
    }
}
