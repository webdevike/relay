// What the phone's network needs from GPT-Live's WebRTC answer, and what to say when it still
// does not connect.
//
// GPT-Live's answer offers IPv4 candidates only (ICE-lite, UDP 3478 and TCP 443). On an IPv6-only
// cellular network with NAT64 (T-Mobile, where Isaac's iPhone is), WebRTC's IPv6 host candidates
// cannot reach an IPv4 literal, so the call never connects and GPT-Live never starts the session.
// iOS synthesizes the NAT64 address of an IPv4 literal through getaddrinfo (Apple's IPv6-only
// guidance); each IPv4 candidate also goes in as that address, just below it in priority, so the
// connectivity checks reach OpenAI through the carrier's NAT64. ICE-lite answers checks from
// whatever address they arrive from, so the translated path works like any NAT. On networks
// without NAT64 getaddrinfo returns the IPv4 address only and the answer is left as it was.

import Darwin
import Foundation
import WebRTC

enum LiveCallNetwork {
  /// `sdp` with every IPv4 candidate followed by its NAT64 twin, and how many twins were added.
  static func withNat64Candidates(_ sdp: String) -> (sdp: String, added: Int) {
    var lines: [String] = []
    var added = 0
    for line in sdp.components(separatedBy: "\r\n") {
      lines.append(line)
      guard let twin = nat64Twin(of: line) else { continue }
      lines.append(twin)
      added += 1
    }
    return (lines.joined(separator: "\r\n"), added)
  }

  /// `a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ ...` for an
  /// IPv4 candidate, as the same candidate at its NAT64 address; nil when there is none.
  static func nat64Twin(of line: String) -> String? {
    guard line.hasPrefix("a=candidate:") else { return nil }
    var fields = line.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
    guard fields.count > 7, isIPv4(fields[4]), let priority = UInt32(fields[3]), priority > 0,
      let address = synthesizedIPv6(for: fields[4], port: fields[5], udp: fields[2].lowercased() == "udp")
    else { return nil }
    fields[0] += "6"
    fields[3] = String(priority - 1)
    fields[4] = address
    return fields.joined(separator: " ")
  }

  private static func isIPv4(_ address: String) -> Bool {
    var parsed = in_addr()
    return inet_pton(AF_INET, address, &parsed) == 1
  }

  /// The IPv6 address this network's NAT64 maps `ipv4` to; nil without NAT64.
  private static func synthesizedIPv6(for ipv4: String, port: String, udp: Bool) -> String? {
    var hints = addrinfo()
    hints.ai_family = AF_UNSPEC
    hints.ai_socktype = udp ? SOCK_DGRAM : SOCK_STREAM
    hints.ai_flags = AI_V4MAPPED_CFG | AI_ADDRCONFIG
    var result: UnsafeMutablePointer<addrinfo>?
    guard getaddrinfo(ipv4, port, &hints, &result) == 0, let first = result else { return nil }
    defer { freeaddrinfo(first) }
    var cursor: UnsafeMutablePointer<addrinfo>? = first
    while let info = cursor {
      if info.pointee.ai_family == AF_INET6, let address = info.pointee.ai_addr {
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        if getnameinfo(address, info.pointee.ai_addrlen, &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
          let text = String(cString: host)
          // A v4-mapped address (::ffff:a.b.c.d) is the IPv4 path again, not NAT64.
          if !text.lowercased().hasPrefix("::ffff:") { return text }
        }
      }
      cursor = info.pointee.ai_next
    }
    return nil
  }

  /// One line for the host log when the call did not go live: where ICE, the peer connection and
  /// the events channel stood, and which candidates each side had.
  static func diagnosis(peer: RTCPeerConnection?, channel: RTCDataChannel?, nat64Added: Int) -> String {
    guard let peer else { return "no peer connection" }
    let local = candidateSummary(peer.localDescription?.sdp)
    let remote = candidateSummary(peer.remoteDescription?.sdp)
    return "ice \(name(of: peer.iceConnectionState)), peer \(name(of: peer.connectionState)), "
      + "events channel \(channel.map { name(of: $0.readyState) } ?? "none"); "
      + "local \(local), remote \(remote), NAT64 twins \(nat64Added)"
  }

  /// Candidates of `sdp` by transport, family and type: "udp6 host 2, udp4 host 1".
  static func candidateSummary(_ sdp: String?) -> String {
    guard let sdp else { return "none" }
    var counts: [String: Int] = [:]
    var order: [String] = []
    for line in sdp.components(separatedBy: "\r\n") where line.hasPrefix("a=candidate:") {
      let fields = line.split(separator: " ").map(String.init)
      guard fields.count > 7 else { continue }
      let key = "\(fields[2].lowercased())\(fields[4].contains(":") ? "6" : "4") \(fields[7])"
      if counts[key] == nil { order.append(key) }
      counts[key, default: 0] += 1
    }
    return order.isEmpty ? "none" : order.map { "\($0) \(counts[$0] ?? 0)" }.joined(separator: ", ")
  }

  private static func name(of state: RTCIceConnectionState) -> String {
    switch state {
    case .new: return "new"
    case .checking: return "checking"
    case .connected: return "connected"
    case .completed: return "completed"
    case .failed: return "failed"
    case .disconnected: return "disconnected"
    case .closed: return "closed"
    default: return "unknown"
    }
  }

  private static func name(of state: RTCPeerConnectionState) -> String {
    switch state {
    case .new: return "new"
    case .connecting: return "connecting"
    case .connected: return "connected"
    case .disconnected: return "disconnected"
    case .failed: return "failed"
    case .closed: return "closed"
    default: return "unknown"
    }
  }

  private static func name(of state: RTCDataChannelState) -> String {
    switch state {
    case .connecting: return "connecting"
    case .open: return "open"
    case .closing: return "closing"
    case .closed: return "closed"
    default: return "unknown"
    }
  }
}
