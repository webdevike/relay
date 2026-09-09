// Owns the RelayServer and its dependencies; the single source of truth the SwiftUI menu reads.
// `PairingUI` requirements are called on the server's private queue, never the main thread, so
// they hop to `@MainActor` before touching any `@Published` state.

import AppKit
import Foundation
import RelayCore
import RelayProtocol

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var state: RelayServer.ServerState = .stopped
    @Published private(set) var devices: [PairedDevice] = []
    @Published private(set) var connected: [RelayServer.ConnectedDevice] = []
    @Published private(set) var accessibilityGranted: Bool
    @Published private(set) var pairing: (deviceName: String, pin: String)?

    private let deviceStore = KeychainDeviceStore()
    private let accessibility = SystemAccessibility()
    private let server: RelayServer
    private let pairingWindow = PairingWindowController()
    private var pollTimer: Timer?
    private var menuOpen = false

    init() {
        accessibilityGranted = accessibility.isTrusted
        let poster = SystemEventPoster()
        let checker = accessibility
        let macName = Host.current().localizedName ?? "Mac"
        let config = RelayServer.Config(port: nil, macName: macName, version: relayVersion)
        let pairingBox = RelayServerPairingUIBox()
        server = RelayServer(
            config: config,
            deps: RelayServer.Dependencies(
                input: TrackpadInputSink(poster: poster),
                text: KeyboardInjector(poster: poster, accessibility: checker),
                accessibility: checker,
                agents: nil,
                devices: deviceStore,
                pairing: pairingBox
            )
        )
        server.onStateChange = { [weak self] newState in
            Task { @MainActor in self?.state = newState }
        }
        devices = deviceStore.pairedDevices()
        pairingBox.target = self
    }

    func start() {
        do {
            try server.start()
        } catch {
            state = .failed("\(error)")
        }
        updatePolling()
    }

    func menuWillAppear() {
        menuOpen = true
        refreshDevices()
        refreshConnected()
        checkAccessibility()
        updatePolling()
    }

    func menuWillDisappear() {
        menuOpen = false
        updatePolling()
    }

    func forget(deviceId: String) {
        deviceStore.forget(deviceId: deviceId)
        refreshDevices()
    }

    func requestAccessibilityAccess() {
        accessibility.requestAccess()
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    /// The pairing window's Cancel button: hides the prompt locally without touching the
    /// server's pairing state, which keeps running until it times out on its own.
    func dismissPairingWindow() {
        pairingWindow.hide()
    }

    private func refreshDevices() {
        devices = deviceStore.pairedDevices()
    }

    private func refreshConnected() {
        connected = server.connectedDevices
    }

    private func checkAccessibility() {
        let trusted = accessibility.isTrusted
        if trusted != accessibilityGranted {
            accessibilityGranted = trusted
            server.broadcastMacState()
        }
    }

    private func updatePolling() {
        let shouldPoll = menuOpen || !accessibilityGranted
        switch (shouldPoll, pollTimer) {
        case (true, .none):
            pollTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    self?.checkAccessibility()
                    if self?.menuOpen == true { self?.refreshConnected() }
                }
            }
        case (false, .some(let timer)):
            timer.invalidate()
            pollTimer = nil
        default:
            break
        }
    }

    fileprivate func handleBeginPairing(deviceName: String, pin: String) {
        pairing = (deviceName, pin)
        pairingWindow.show(deviceName: deviceName, pin: pin, onCancel: { [weak self] in self?.dismissPairingWindow() })
    }

    fileprivate func handleEndPairing() {
        pairing = nil
        pairingWindow.hide()
    }
}

/// `PairingUI` is called on `RelayServer`'s private queue; this box exists only so a plain
/// `AnyObject` can be handed to `RelayServer.Dependencies` before `AppModel` itself has finished
/// initializing (it owns the server that needs this box). It forwards straight to `AppModel`,
/// hopping to the main actor.
private final class RelayServerPairingUIBox: PairingUI {
    weak var target: AppModel?

    func beginPairing(deviceName: String, pin: String) {
        Task { @MainActor [weak target] in target?.handleBeginPairing(deviceName: deviceName, pin: pin) }
    }

    func endPairing() {
        Task { @MainActor [weak target] in target?.handleEndPairing() }
    }
}
