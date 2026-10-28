// The live call's own connection to the Relay host, separate from the JS one (an App Intent runs
// with no JS): the same WebSocket `/relay` handshake (hello -> challenge -> auth -> welcome), then
// only `live.*` frames and a ping every 15 s. Hosts are tried in order, each with a short deadline.

import CryptoKit
import Foundation

private struct LinkError: Error {
  let message: String
}

@MainActor
final class LiveCallHostLink {
  /// Frames after the welcome (`live.answer`, `live.state`, ...); unknown ones are the caller's to ignore.
  var onFrame: (([String: Any]) -> Void)?
  /// The socket closed after the welcome.
  var onClose: ((String) -> Void)?
  private(set) var host: LiveCallHost?

  private var session: URLSession?
  private var task: URLSessionWebSocketTask?
  private var pingTimer: Timer?
  private var challenge: LiveCallWaiter<String>?
  private var welcome: LiveCallWaiter<Void>?
  private var closed = false

  /// Connects and authenticates with the first host that answers. Throws `LiveCallFailure.fallback`.
  func connect(to hosts: [LiveCallHost], secondsPerHost: Double) async throws {
    guard !hosts.isEmpty else {
      throw LiveCallFailure.fallback("This phone has no paired Mac for live calls yet; open Relay once while connected.")
    }
    var errors: [String] = []
    for host in hosts {
      if closed { throw LiveCallFailure.cancelled }
      do {
        try await open(host, seconds: secondsPerHost)
        self.host = host
        startPings()
        return
      } catch {
        errors.append("\(host.name): \((error as? LinkError)?.message ?? error.localizedDescription)")
        dropSocket()
      }
    }
    if closed { throw LiveCallFailure.cancelled }
    throw LiveCallFailure.fallback("Couldn't reach your Mac (\(errors.joined(separator: "; ")))")
  }

  func send(_ frame: [String: Any]) {
    guard let task, let data = try? JSONSerialization.data(withJSONObject: frame), let text = String(data: data, encoding: .utf8) else { return }
    task.send(.string(text)) { _ in }
  }

  /// Sends `frame` and waits (at most `seconds`) for it to leave, so a close right after does not drop it.
  func sendAndWait(_ frame: [String: Any], seconds: Double) async {
    guard let task, let data = try? JSONSerialization.data(withJSONObject: frame), let text = String(data: data, encoding: .utf8) else { return }
    let sent = LiveCallWaiter<Void>()
    task.send(.string(text)) { _ in
      DispatchQueue.main.async {
        MainActor.assumeIsolated { sent.resolve(()) }
      }
    }
    try? await sent.wait(seconds: seconds, timeoutError: LiveCallFailure.cancelled)
  }

  func close() {
    closed = true
    challenge?.fail(LiveCallFailure.cancelled)
    welcome?.fail(LiveCallFailure.cancelled)
    dropSocket()
  }

  private func open(_ host: LiveCallHost, seconds: Double) async throws {
    guard let url = URL(string: host.url), url.scheme == "ws" || url.scheme == "wss" else {
      throw LinkError(message: "bad address \(host.url)")
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = seconds
    configuration.waitsForConnectivity = false
    let session = URLSession(configuration: configuration)
    let task = session.webSocketTask(with: url)
    // The welcome carries the host's whole state; URLSession's default cap is 1 MiB.
    task.maximumMessageSize = 64 * 1024 * 1024
    self.session = session
    self.task = task
    let challenge = LiveCallWaiter<String>()
    let welcome = LiveCallWaiter<Void>()
    self.challenge = challenge
    self.welcome = welcome
    task.resume()
    receive(task)
    send(["t": "hello", "v": 1, "deviceId": host.deviceId, "deviceName": host.deviceName, "platform": "ios"])
    let nonce = try await challenge.wait(seconds: seconds, timeoutError: LinkError(message: "no answer"))
    send(["t": "auth", "proof": Self.proof(secretHex: host.secretHex, nonce: nonce)])
    try await welcome.wait(seconds: seconds, timeoutError: LinkError(message: "not accepted in time"))
  }

  /// lowercase hex(HMAC-SHA256(key = bytes of the hex secret, message = utf8(nonce))), as `authProof` in @relay/protocol.
  static func proof(secretHex: String, nonce: String) -> String {
    let key = SymmetricKey(data: bytes(fromHex: secretHex))
    let mac = HMAC<SHA256>.authenticationCode(for: Data(nonce.utf8), using: key)
    return mac.map { String(format: "%02x", $0) }.joined()
  }

  private static func bytes(fromHex hex: String) -> Data {
    var data = Data(capacity: hex.count / 2)
    var index = hex.startIndex
    while index < hex.endIndex, let next = hex.index(index, offsetBy: 2, limitedBy: hex.endIndex) {
      if let byte = UInt8(hex[index..<next], radix: 16) { data.append(byte) }
      index = next
    }
    return data
  }

  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self?.received(result, from: task)
        }
      }
    }
  }

  private func received(_ result: Result<URLSessionWebSocketTask.Message, Error>, from task: URLSessionWebSocketTask) {
    guard task === self.task else { return }
    switch result {
    case .failure(let error):
      lost(error.localizedDescription)
    case .success(let message):
      let text: String?
      switch message {
      case .string(let string): text = string
      case .data(let data): text = String(data: data, encoding: .utf8)
      @unknown default: text = nil
      }
      if let text { handle(text) }
      receive(task)
    }
  }

  private func handle(_ text: String) {
    // The welcome is large and its contents are not needed here; skip parsing it.
    if welcome?.isSettled == false && text.hasPrefix("{\"t\":\"welcome\"") {
      welcome?.resolve(())
      return
    }
    guard let data = text.data(using: .utf8),
      let frame = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let type = frame["t"] as? String
    else { return }
    guard welcome?.isSettled == true else {
      switch type {
      case "challenge": challenge?.resolve(frame["nonce"] as? String ?? "")
      case "welcome": welcome?.resolve(())
      case "unpaired": fail("this phone is not paired with it")
      case "error": fail((frame["message"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (frame["code"] as? String) ?? "refused")
      default: break
      }
      return
    }
    onFrame?(frame)
  }

  private func fail(_ message: String) {
    challenge?.fail(LinkError(message: message))
    welcome?.fail(LinkError(message: message))
  }

  private func lost(_ reason: String) {
    if welcome?.isSettled == true {
      dropSocket()
      if !closed {
        closed = true
        onClose?(reason)
      }
    } else {
      fail(reason)
    }
  }

  private func startPings() {
    pingTimer?.invalidate()
    pingTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.send(["t": "ping", "ts": Int(Date().timeIntervalSince1970 * 1000)])
      }
    }
  }

  private func dropSocket() {
    pingTimer?.invalidate()
    pingTimer = nil
    task?.cancel(with: .normalClosure, reason: nil)
    task = nil
    session?.invalidateAndCancel()
    session = nil
  }
}
