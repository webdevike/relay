import Foundation

/// Enforces "only one pairing in progress anywhere on the server" and pairs every `beginPairing`
/// with exactly one `endPairing` on the injected `PairingUI`. Shared by every `ClientSession` on a
/// `RelayServer`; all access happens on the server's serial queue, so no locking is needed.
final class PairingCoordinator {
    private let pairingUI: PairingUI
    private(set) var isPairingInProgress = false

    init(pairingUI: PairingUI) {
        self.pairingUI = pairingUI
    }

    /// Starts pairing for `deviceName`/`pin`. Returns `false` (and does nothing) if another
    /// pairing is already in progress.
    func begin(deviceName: String, pin: String) -> Bool {
        guard !isPairingInProgress else { return false }
        isPairingInProgress = true
        pairingUI.beginPairing(deviceName: deviceName, pin: pin)
        return true
    }

    /// Idempotent: safe to call even when no pairing is in progress.
    func end() {
        guard isPairingInProgress else { return }
        isPairingInProgress = false
        pairingUI.endPairing()
    }
}
