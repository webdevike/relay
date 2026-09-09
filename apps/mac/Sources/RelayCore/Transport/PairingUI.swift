import Foundation

/// Implemented by the app: shows and hides the pairing PIN prompt. The transport always pairs a
/// `beginPairing` call with exactly one later `endPairing` call, on every exit path (success,
/// wrong PIN exhaustion, timeout, disconnect, or protocol error while pending).
public protocol PairingUI: AnyObject {
    func beginPairing(deviceName: String, pin: String)
    func endPairing()
}
