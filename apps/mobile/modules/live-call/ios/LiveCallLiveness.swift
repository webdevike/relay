// Whether a live call is still alive, from what the engine last heard. Pure (Foundation only, no
// clock of its own) so `test/main.swift` runs it with swiftc on a Mac (`pnpm test:native`).
//
//   live --(host link or WebRTC lost)--> reconnecting --(back)--> live
//   reconnecting --(still lost after reconnectGrace)--> end
//   live --(nothing heard for silenceLimit)--> end
//
// "Heard" is anything from the other side: a host frame (the host answers the link's ping every
// 15 s), a data channel event, or more audio packets from GPT-Live. A process the system suspended
// hears nothing, so the first check after it wakes ends a call that died meanwhile.

import Foundation

public struct LiveCallLiveness: Equatable {
  /// How long the host link or the WebRTC connection may be gone before the call ends.
  public static let reconnectGrace: TimeInterval = 20
  /// How long the call may hear nothing at all before it ends.
  public static let silenceLimit: TimeInterval = 45

  public enum Verdict: Equatable {
    case live
    case reconnecting
    case end(String)
  }

  public private(set) var hostLostAt: Date?
  public private(set) var peerLostAt: Date?
  public private(set) var lastHeardAt: Date

  public init(now: Date) {
    lastHeardAt = now
  }

  public mutating func heard(at now: Date) {
    if now > lastHeardAt { lastHeardAt = now }
  }

  public mutating func hostLost(at now: Date) {
    if hostLostAt == nil { hostLostAt = now }
  }

  public mutating func hostBack(at now: Date) {
    hostLostAt = nil
    heard(at: now)
  }

  public mutating func peerLost(at now: Date) {
    if peerLostAt == nil { peerLostAt = now }
  }

  public mutating func peerBack(at now: Date) {
    peerLostAt = nil
    heard(at: now)
  }

  public func verdict(at now: Date) -> Verdict {
    if let at = peerLostAt, now.timeIntervalSince(at) >= Self.reconnectGrace { return .end("Lost the voice connection") }
    if let at = hostLostAt, now.timeIntervalSince(at) >= Self.reconnectGrace { return .end("Lost the connection to your Mac") }
    if now.timeIntervalSince(lastHeardAt) >= Self.silenceLimit { return .end("The call stopped responding") }
    if peerLostAt != nil || hostLostAt != nil { return .reconnecting }
    return .live
  }
}
