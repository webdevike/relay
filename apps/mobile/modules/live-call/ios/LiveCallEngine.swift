// A live call: a GPT-Live voice conversation with one assistant (the voice is OpenAI's full-duplex
// model, the brain is the assistant's own thread on the Relay host). Fully native, so the App
// Intents (Action Button, lock screen, Shortcuts) can run it with no JavaScript loaded; the JS
// module (LiveCallModule) drives the same engine from the app.
//
// start(agent): haptic -> Live Activity -> microphone + audio session -> peer connection (mic
// track, `oai-events` data channel) -> offer with every ICE candidate -> host link (handshake) ->
// `live.start` -> `live.answer` -> remote description -> `session.started` on the data channel:
// listening. Anything failing before that ends the call cleanly and reports a fallback (the
// legacy call); once live, failures just end it. end(): `session.close` (waiting up to 3 s for
// `session.closed`), `live.end` to the host, everything closed, audio session handed back, the
// Live Activity ended. One call at a time: starting another ends the current one first.

import AVFoundation
import Foundation
import UIKit
import WebRTC

/// How `start` came out.
public enum LiveCallOutcome: Equatable {
  /// GPT-Live started the session: Isaac and the assistant are talking.
  case live
  /// Hung up (or replaced) before it went live.
  case ended
  /// GPT-Live is unavailable; a pending fallback was stored for the legacy call.
  case fallback(String)
  /// Calling cannot work (microphone denied, audio session refused).
  case failed(String)

  public var name: String {
    switch self {
    case .live: return "live"
    case .ended: return "ended"
    case .fallback: return "fallback"
    case .failed: return "failed"
    }
  }

  public var message: String? {
    switch self {
    case .fallback(let message), .failed(let message): return message
    case .live, .ended: return nil
    }
  }
}

/// Where the running call stands, as JS and the Live Activity see it.
public struct LiveCallSnapshot: Equatable {
  public let agent: String
  public let callId: String
  /// `connecting`, `listening`, `thinking`, `speaking` or `ended`.
  public var state: String
  /// What the assistant is working on (`thinking`): Isaac's words, from the host.
  public var text: String?
  /// Isaac's latest words, from GPT-Live's input transcript.
  public var you: String?
  /// The assistant's latest spoken words.
  public var assistant: String?
  /// The newest of `you` (as "You: ...") and `assistant`: the Live Activity's line.
  public var line: String
  public var error: String?
  public var muted: Bool
  /// On `ended`: the legacy call is starting instead.
  public var fallback: Bool
  public let startedAt: Date

  public var dictionary: [String: Any] {
    var out: [String: Any] = [
      "agent": agent,
      "callId": callId,
      "state": state,
      "line": line,
      "muted": muted,
      "fallback": fallback,
      "startedAt": startedAt.timeIntervalSince1970 * 1000,
    ]
    if let text { out["text"] = text }
    if let you { out["you"] = you }
    if let assistant { out["assistant"] = assistant }
    if let error { out["error"] = error }
    return out
  }
}

private enum Speaker {
  case you
  case assistant
}

/// One call's connections and progress.
@MainActor
private final class LiveCallRun {
  let id = UUID().uuidString.lowercased()
  let agent: String
  let startedAt = Date()
  let observer = LiveCallPeerObserver()
  let link = LiveCallHostLink()
  let gathered = LiveCallWaiter<Void>()
  let answer = LiveCallWaiter<String>()
  let started = LiveCallWaiter<Void>()
  let closed = LiveCallWaiter<Void>()
  var peer: RTCPeerConnection?
  var channel: RTCDataChannel?
  var track: RTCAudioTrack?
  var live = false
  var ending = false
  var hostThinking = false
  var lastSpeaker: Speaker?
  var youEndMs: Int?
  var speakingTimer: Task<Void, Never>?
  var disconnectTimer: Task<Void, Never>?
  var audioObservers: [NSObjectProtocol] = []

  init(agent: String) {
    self.agent = agent
  }

  /// Ends every wait `start` may be in, so it returns.
  func failWaits(_ error: Error) {
    gathered.fail(error)
    answer.fail(error)
    started.fail(error)
  }
}

@MainActor
public final class LiveCallEngine {
  public static let shared = LiveCallEngine()

  /// Every change of `snapshot` (also the final `ended` one). Set by the JS module.
  public var onState: ((LiveCallSnapshot) -> Void)?
  /// A call that could not go live: (agent, reason). The pending fallback is already stored.
  public var onFallback: ((String, String) -> Void)?
  /// The running call; nil when there is none.
  public private(set) var snapshot: LiveCallSnapshot?

  private var run: LiveCallRun?
  private let activity = LiveCallActivity()
  private lazy var factory: RTCPeerConnectionFactory = {
    RTCInitializeSSL()
    return RTCPeerConnectionFactory()
  }()
  private static let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
  /// Time per host to connect and authenticate before trying the next one.
  private static let hostSeconds: Double = 4
  private static let answerSeconds: Double = 12
  private static let sessionSeconds: Double = 10

  private init() {}

  public static func displayName(of agent: String) -> String {
    agent.prefix(1).uppercased() + agent.dropFirst()
  }

  /// Saves the paired hosts (preferred first) for calls started with no JS (lock screen intents).
  public func configure(hosts: [LiveCallHost]) {
    LiveCallHostStore.save(hosts)
  }

  /// Whether a call is running (with `agent`, when given) and not already ending.
  public func isActive(agent: String? = nil) -> Bool {
    guard let run, !run.ending else { return false }
    return agent == nil || run.agent == agent
  }

  /// Ends the call with `agent` if one is running (nil), else starts one.
  @discardableResult
  public func toggle(agent: String) async -> LiveCallOutcome? {
    if isActive(agent: agent) {
      await end()
      return nil
    }
    return await start(agent: agent)
  }

  /// Starts a call with `agent`; returns once it is live, or why it is not.
  public func start(agent: String) async -> LiveCallOutcome {
    if let current = run { await finish(current, error: nil, fallback: false) }
    LiveCallPendingFallback.clear()
    activity.endStale()
    let run = LiveCallRun(agent: agent)
    self.run = run
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    snapshot = LiveCallSnapshot(
      agent: agent, callId: run.id, state: "connecting", text: nil, you: nil, assistant: nil, line: "",
      error: nil, muted: false, fallback: false, startedAt: run.startedAt)
    activity.start(agent: agent, agentName: Self.displayName(of: agent), startedAt: run.startedAt)
    if let snapshot { onState?(snapshot) }
    NSLog("[LiveCall] start \(agent) \(run.id)")

    do {
      try await connect(run)
    } catch {
      if run.ending || self.run !== run { return .ended }
      switch error as? LiveCallFailure ?? .fallback(error.localizedDescription) {
      case .cancelled:
        await finish(run, error: nil, fallback: false)
        return .ended
      case .failed(let message):
        await finish(run, error: message, fallback: false)
        return .failed(message)
      case .fallback(let reason):
        await finish(run, error: reason, fallback: true)
        return .fallback(reason)
      }
    }
    if run.ending || self.run !== run { return .ended }
    run.live = true
    NSLog("[LiveCall] live \(run.id)")
    UINotificationFeedbackGenerator().notificationOccurred(.success)
    update(run) { $0.state = run.hostThinking ? "thinking" : "listening" }
    return .live
  }

  /// Hangs up the running call, if any. `reason` only when it failed.
  public func end(reason: String? = nil) async {
    guard let run else { return }
    await finish(run, error: reason, fallback: false)
  }

  public func setMuted(_ muted: Bool) {
    guard let run, !run.ending else { return }
    run.track?.isEnabled = !muted
    sendEvent(["type": muted ? "session.input_audio.mute" : "session.input_audio.unmute"], on: run)
    update(run) { $0.muted = muted }
  }

  // MARK: - Starting

  private func connect(_ run: LiveCallRun) async throws {
    try await requireMicrophone()
    try check(run)
    try startAudio()
    observeAudioSession(run)
    let peer = try makePeer(run)
    let offer = try await peer.offer(for: Self.constraints)
    try check(run)
    try await peer.setLocalDescription(offer)
    // Non-trickle: the host sends the offer to OpenAI whole. With no ICE servers this takes
    // milliseconds; past the deadline, whatever was gathered goes.
    try? await run.gathered.wait(seconds: 3, timeoutError: LiveCallFailure.cancelled)
    try check(run)
    guard let sdp = peer.localDescription?.sdp else { throw LiveCallFailure.fallback("No WebRTC offer") }

    run.link.onFrame = { [weak self, weak run] frame in
      guard let self, let run else { return }
      self.hostFrame(frame, run)
    }
    run.link.onClose = { [weak run] reason in
      // The voice flows phone <-> OpenAI; without the host the call goes on, it just hears no `thinking`.
      NSLog("[LiveCall] host link closed: \(reason)")
      if let run, !run.live { run.failWaits(LiveCallFailure.fallback("Lost the connection to your Mac")) }
    }
    try await run.link.connect(to: LiveCallHostStore.load(), secondsPerHost: Self.hostSeconds)
    try check(run)
    run.link.send(["t": "live.start", "callId": run.id, "agent": run.agent, "sdp": sdp])
    let answer = try await run.answer.wait(
      seconds: Self.answerSeconds, timeoutError: LiveCallFailure.fallback("Your Mac did not answer the live call"))
    try check(run)
    do {
      try await peer.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: answer))
    } catch {
      throw LiveCallFailure.fallback("GPT-Live's answer was unusable: \(error.localizedDescription)")
    }
    try await run.started.wait(
      seconds: Self.sessionSeconds, timeoutError: LiveCallFailure.fallback("GPT-Live did not start the session"))
  }

  private func check(_ run: LiveCallRun) throws {
    if run.ending || self.run !== run { throw LiveCallFailure.cancelled }
  }

  private func requireMicrophone() async throws {
    let denied = LiveCallFailure.failed("Relay needs the microphone for calls: allow it in Settings > Relay.")
    switch AVAudioApplication.shared.recordPermission {
    case .granted:
      return
    case .denied:
      throw denied
    default:
      if !(await AVAudioApplication.requestRecordPermission()) { throw denied }
    }
  }

  private func makePeer(_ run: LiveCallRun) throws -> RTCPeerConnection {
    run.observer.onGatheringComplete = { [weak run] in run?.gathered.resolve(()) }
    run.observer.onPeerState = { [weak self, weak run] state in
      guard let self, let run else { return }
      self.peerStateChanged(state, run)
    }
    run.observer.onMessage = { [weak self, weak run] data in
      guard let self, let run else { return }
      self.channelMessage(data, run)
    }

    let configuration = RTCConfiguration()
    configuration.sdpSemantics = .unifiedPlan
    configuration.bundlePolicy = .maxBundle
    configuration.rtcpMuxPolicy = .require
    configuration.iceServers = []
    guard let peer = factory.peerConnection(with: configuration, constraints: Self.constraints, delegate: run.observer) else {
      throw LiveCallFailure.fallback("Couldn't create the WebRTC connection")
    }
    run.peer = peer

    // GPT-Live's events channel must exist before the offer.
    let channelConfiguration = RTCDataChannelConfiguration()
    channelConfiguration.isOrdered = true
    guard let channel = peer.dataChannel(forLabel: "oai-events", configuration: channelConfiguration) else {
      throw LiveCallFailure.fallback("Couldn't create the GPT-Live events channel")
    }
    channel.delegate = run.observer
    run.channel = channel

    let track = factory.audioTrack(with: factory.audioSource(with: Self.constraints), trackId: "relay-mic")
    let transceiver = RTCRtpTransceiverInit()
    transceiver.direction = .sendRecv
    transceiver.streamIds = ["relay-live"]
    guard peer.addTransceiver(with: track, init: transceiver) != nil else {
      throw LiveCallFailure.fallback("Couldn't add the microphone to the call")
    }
    run.track = track
    return peer
  }

  // MARK: - Audio

  /// Voice chat on the speaker, or AirPods (HFP, so their microphone works): WebRTC's
  /// voice-processing audio unit then cancels the assistant's voice from the microphone.
  private func startAudio() throws {
    let configuration = RTCAudioSessionConfiguration.webRTC()
    configuration.category = AVAudioSession.Category.playAndRecord.rawValue
    configuration.mode = AVAudioSession.Mode.voiceChat.rawValue
    configuration.categoryOptions = [.allowBluetoothHFP, .defaultToSpeaker]
    RTCAudioSessionConfiguration.setWebRTC(configuration)
    let session = RTCAudioSession.sharedInstance()
    session.lockForConfiguration()
    defer { session.unlockForConfiguration() }
    do {
      try session.setConfiguration(configuration, active: true)
    } catch {
      throw LiveCallFailure.failed("Couldn't open the microphone: \(error.localizedDescription)")
    }
  }

  /// Hands the audio session back (others notified, so music resumes).
  private func stopAudio() {
    let session = RTCAudioSession.sharedInstance()
    session.lockForConfiguration()
    try? session.setActive(false)
    session.unlockForConfiguration()
  }

  private func observeAudioSession(_ run: LiveCallRun) {
    let center = NotificationCenter.default
    run.audioObservers.append(
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self, weak run] note in
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        guard raw.flatMap(AVAudioSession.InterruptionType.init(rawValue:)) == .began else { return }
        MainActor.assumeIsolated {
          // A phone call or Siri took the audio: the call ends rather than going deaf.
          guard let self, let run, !run.ending else { return }
          if run.live {
            Task { await self.finish(run, error: "The call was interrupted", fallback: false) }
          } else {
            run.failWaits(LiveCallFailure.failed("The call was interrupted"))
          }
        }
      })
    run.audioObservers.append(
      center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self, weak run] note in
        let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        let reason = raw.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
        MainActor.assumeIsolated {
          guard let self, let run, !run.ending else { return }
          let session = AVAudioSession.sharedInstance()
          let outputs = session.currentRoute.outputs.map(\.portType.rawValue).joined(separator: ",")
          NSLog("[LiveCall] route \(String(describing: reason)) -> \(outputs)")
          // AirPods in or out is WebRTC's to follow; something else switching the category away
          // (another audio player) would silence the call, so take it back.
          if reason == .categoryChange && session.category != .playAndRecord {
            try? self.startAudio()
          }
        }
      })
  }

  // MARK: - Host and GPT-Live events

  private func hostFrame(_ frame: [String: Any], _ run: LiveCallRun) {
    guard frame["callId"] as? String == run.id, !run.ending else { return }
    switch frame["t"] as? String {
    case "live.answer":
      if let sdp = frame["sdp"] as? String { run.answer.resolve(sdp) }
    case "live.state":
      switch frame["state"] as? String {
      case "thinking":
        run.hostThinking = true
        let text = frame["text"] as? String
        update(run) {
          $0.text = text
          if run.live { $0.state = "thinking" }
        }
      case "listening":
        run.hostThinking = false
        update(run) {
          $0.text = nil
          if run.live && $0.state == "thinking" { $0.state = "listening" }
        }
      case "ended":
        let error = (frame["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        if !run.live || frame["fallback"] as? Bool == true {
          run.failWaits(LiveCallFailure.fallback(error ?? "Live calls are unavailable on your Mac"))
        } else {
          Task { await self.finish(run, error: error, fallback: false, hostEnded: true) }
        }
      default:
        break
      }
    default:
      break
    }
  }

  private func channelMessage(_ data: Data, _ run: LiveCallRun) {
    guard !run.ending,
      let event = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let type = event["type"] as? String
    else { return }
    switch type {
    case "session.started":
      run.started.resolve(())
    case "session.input_transcript.delta":
      let delta = event["delta"] as? String ?? ""
      // A new utterance: the assistant spoke in between, or Isaac paused for over 1.5 s.
      var fresh = run.lastSpeaker != .you
      if let start = event["start_ms"] as? Int, let lastEnd = run.youEndMs, start - lastEnd > 1500 { fresh = true }
      run.lastSpeaker = .you
      if let end = event["end_ms"] as? Int { run.youEndMs = end }
      update(run) {
        let you = Self.clip((fresh ? "" : $0.you ?? "") + delta)
        $0.you = you
        $0.line = "You: \(you.trimmingCharacters(in: .whitespaces))"
      }
    case "session.output_transcript.delta":
      let delta = event["delta"] as? String ?? ""
      let fresh = run.lastSpeaker != .assistant
      run.lastSpeaker = .assistant
      update(run) {
        let said = Self.clip((fresh ? "" : $0.assistant ?? "") + delta)
        $0.assistant = said
        $0.line = said.trimmingCharacters(in: .whitespaces)
        if run.live { $0.state = "speaking" }
      }
      // No "done" event for the voice: back to listening once its words stop coming.
      run.speakingTimer?.cancel()
      run.speakingTimer = Task { @MainActor [weak self, weak run] in
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        guard !Task.isCancelled, let self, let run else { return }
        self.update(run) { if $0.state == "speaking" { $0.state = run.hostThinking ? "thinking" : "listening" } }
      }
    case "session.closed":
      run.closed.resolve(())
      if run.live {
        Task { await self.finish(run, error: nil, fallback: false) }
      } else {
        run.failWaits(LiveCallFailure.fallback("GPT-Live closed the session"))
      }
    case "error":
      let message = ((event["error"] as? [String: Any])?["message"] as? String) ?? (event["message"] as? String) ?? "GPT-Live error"
      NSLog("[LiveCall] GPT-Live error: \(message)")
      if run.live {
        update(run) { $0.error = message }
      } else {
        run.failWaits(LiveCallFailure.fallback(message))
      }
    default:
      break
    }
  }

  private func peerStateChanged(_ state: RTCPeerConnectionState, _ run: LiveCallRun) {
    guard !run.ending else { return }
    switch state {
    case .connected:
      run.disconnectTimer?.cancel()
      run.disconnectTimer = nil
    case .disconnected:
      // Often a network handover that recovers; give it a few seconds.
      run.disconnectTimer?.cancel()
      run.disconnectTimer = Task { @MainActor [weak self, weak run] in
        try? await Task.sleep(nanoseconds: 6_000_000_000)
        guard !Task.isCancelled, let self, let run else { return }
        self.connectionLost(run)
      }
    case .failed:
      connectionLost(run)
    default:
      break
    }
  }

  private func connectionLost(_ run: LiveCallRun) {
    guard !run.ending else { return }
    if run.live {
      Task { await finish(run, error: "Lost the voice connection", fallback: false) }
    } else {
      run.failWaits(LiveCallFailure.fallback("Couldn't connect to GPT-Live"))
    }
  }

  // MARK: - Ending

  private func finish(_ run: LiveCallRun, error: String?, fallback: Bool, hostEnded: Bool = false) async {
    guard !run.ending else { return }
    run.ending = true
    NSLog("[LiveCall] end \(run.id) \(error ?? "hung up")\(fallback ? " (fallback)" : "")")
    run.failWaits(LiveCallFailure.cancelled)
    run.speakingTimer?.cancel()
    run.disconnectTimer?.cancel()
    run.audioObservers.forEach(NotificationCenter.default.removeObserver)
    run.audioObservers = []

    if run.channel?.readyState == .open && !run.closed.isSettled {
      sendEvent(["type": "session.close"], on: run)
      try? await run.closed.wait(seconds: 3, timeoutError: LiveCallFailure.cancelled)
    }
    if !hostEnded && run.link.host != nil {
      var frame: [String: Any] = ["t": "live.end", "callId": run.id]
      if let error { frame["reason"] = String(error.prefix(2000)) }
      await run.link.sendAndWait(frame, seconds: 1)
    }
    run.link.close()
    run.channel?.close()
    run.peer?.close()
    run.channel = nil
    run.peer = nil
    run.track = nil
    stopAudio()

    let ending = snapshot?.callId == run.id ? snapshot : nil
    if self.run === run {
      self.run = nil
      snapshot = nil
    }
    activity.end(line: error ?? "Call ended", startedAt: run.startedAt)
    if var final = ending {
      final.state = "ended"
      final.error = error
      final.fallback = fallback
      onState?(final)
    }
    if fallback, let error {
      LiveCallPendingFallback.store(agent: run.agent, reason: error)
      onFallback?(run.agent, error)
    }
  }

  // MARK: - Helpers

  private func update(_ run: LiveCallRun, _ change: (inout LiveCallSnapshot) -> Void) {
    guard self.run === run, var next = snapshot, next.callId == run.id else { return }
    change(&next)
    guard next != snapshot else { return }
    snapshot = next
    onState?(next)
    activity.update(state: next.state, line: next.line, startedAt: next.startedAt)
  }

  private func sendEvent(_ event: [String: Any], on run: LiveCallRun) {
    guard let channel = run.channel, channel.readyState == .open else { return }
    var event = event
    event["event_id"] = "relay_\(UUID().uuidString.lowercased())"
    guard let data = try? JSONSerialization.data(withJSONObject: event) else { return }
    channel.sendData(RTCDataBuffer(data: data, isBinary: false))
  }

  /// The last 240 characters: a line on a lock screen, not a transcript.
  private static func clip(_ text: String) -> String {
    text.count > 240 ? "…" + String(text.suffix(239)) : text
  }
}
