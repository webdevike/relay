// The phone side of a Relay call's audio. One AVAudioEngine with Apple's voice processing on the
// input (echo cancellation, so the assistant's own voice from the speaker is not heard as Isaac
// talking, and a barge-in still works on speakerphone):
//   - microphone -> 16 kHz mono PCM16, sent to JS as base64 `audio` events of 100 ms each;
//   - `play` schedules the host's 24 kHz mono PCM16 on a player node, in order; `flush` drops
//     everything scheduled (barge-in).
// `level` events (0..1, mic loudness) drive the call screen; `interrupted` fires when iOS takes the
// audio session away (a phone call, Siri), and the call ends.

import AVFoundation
import ExpoModulesCore

private let micRate: Double = 16_000
private let playRate: Double = 24_000
/** 100 ms of 16 kHz PCM16. */
private let frameBytes = Int(micRate / 10) * 2

public class VoiceCallModule: Module {
  private var engine: AVAudioEngine?
  private var player: AVAudioPlayerNode?
  /** Microphone samples (mono, hardware rate) not yet averaged into a 16 kHz sample, and where the next one starts; audio thread only. */
  private var carry: [Float] = []
  private var carryPos: Double = 0
  private var pending = Data()
  private var muted = false
  private var buffersSinceLevel = 0
  private var interruption: NSObjectProtocol?
  /** Guards `pending`, `muted` and `buffersSinceLevel`, touched from the audio thread and from JS. */
  private let lock = NSLock()
  private let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: playRate, channels: 1, interleaved: false)!
  /** What the engine did, for `diagnostics()` when a call hears nothing. Guarded by `lock`. */
  private var taps = 0
  private var lastTapFormat = "none"
  private var framesSent = 0
  private var dropped = "none"
  private var voiceProcessing = "off"

  public func definition() -> ModuleDefinition {
    Name("VoiceCall")
    Events("audio", "level", "interrupted")

    AsyncFunction("requestPermission") { () async -> Bool in
      await AVAudioApplication.requestRecordPermission()
    }

    AsyncFunction("start") { () throws in
      try self.startEngine()
    }

    Function("stop") {
      self.stopEngine()
    }

    Function("setMuted") { (muted: Bool) in
      self.lock.lock()
      self.muted = muted
      self.pending.removeAll()
      self.lock.unlock()
    }

    Function("play") { (pcm: String) in
      self.schedule(pcm)
    }

    Function("flush") {
      guard let player = self.player else { return }
      // Stopping a player node drops every buffer scheduled on it.
      player.stop()
      player.play()
    }

    /** One line describing the session, route, engine and tap, for a call that hears nothing. */
    Function("diagnostics") { () -> String in
      self.diagnostics()
    }

    OnDestroy {
      self.stopEngine()
    }
  }

  private func startEngine() throws {
    stopEngine()
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
    try session.setPreferredIOBufferDuration(0.02)
    try session.setActive(true)

    let engine = AVAudioEngine()
    let input = engine.inputNode
    // Echo cancellation; a call still works without it (no barge-in on speaker), so a failure is noted, not fatal.
    do {
      try input.setVoiceProcessingEnabled(true)
      voiceProcessing = "on"
    } catch {
      voiceProcessing = "failed: \(error.localizedDescription)"
    }
    let player = AVAudioPlayerNode()
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: playFormat)

    lock.lock()
    pending.removeAll()
    muted = false
    buffersSinceLevel = 0
    taps = 0
    lastTapFormat = "none"
    framesSent = 0
    dropped = "none"
    lock.unlock()
    carry = []
    carryPos = 0
    // The node's own format (nil): with voice processing on it can change between configuration
    // and start, and a tap or converter fixed to the earlier format gets nothing usable.
    input.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
      self?.ingest(buffer)
    }
    engine.prepare()
    try engine.start()
    player.play()
    self.engine = engine
    self.player = player
    interruption = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification, object: session, queue: .main
    ) { [weak self] note in
      let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
      if raw == AVAudioSession.InterruptionType.began.rawValue {
        self?.sendEvent("interrupted", [:])
      }
    }
  }

  private func diagnostics() -> String {
    let session = AVAudioSession.sharedInstance()
    let permission: String
    switch AVAudioApplication.shared.recordPermission {
    case .granted: permission = "granted"
    case .denied: permission = "denied"
    case .undetermined: permission = "undetermined"
    @unknown default: permission = "unknown"
    }
    let inputs = session.currentRoute.inputs.map { $0.portType.rawValue }.joined(separator: ",")
    let outputs = session.currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: ",")
    let format = engine.map { node in
      let f = node.inputNode.outputFormat(forBus: 0)
      return "\(Int(f.sampleRate))Hz/\(f.channelCount)ch"
    } ?? "no engine"
    lock.lock()
    let line = "mic \(permission); session \(session.category.rawValue)/\(session.mode.rawValue) inputAvailable=\(session.isInputAvailable) in=[\(inputs)] out=[\(outputs)]; engine running=\(engine?.isRunning ?? false) input \(format) vp \(voiceProcessing); taps \(taps) last \(lastTapFormat); sent \(framesSent); dropped \(dropped)"
    lock.unlock()
    return line
  }

  private func stopEngine() {
    if let interruption {
      NotificationCenter.default.removeObserver(interruption)
      self.interruption = nil
    }
    guard let engine else { return }
    engine.inputNode.removeTap(onBus: 0)
    player?.stop()
    engine.stop()
    self.engine = nil
    self.player = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
  }

  /**
   * Microphone buffer (audio thread): downmix to mono, box-average down to 16 kHz (whatever rate the
   * hardware runs at), PCM16, and send whole 100 ms frames. Done by hand rather than with
   * AVAudioConverter, whose silent failures on voice-processed input left calls deaf.
   */
  private func ingest(_ buffer: AVAudioPCMBuffer) {
    let length = Int(buffer.frameLength)
    let channels = Int(buffer.format.channelCount)
    let rate = buffer.format.sampleRate
    lock.lock()
    taps += 1
    lastTapFormat = "\(length)fr \(Int(rate))Hz/\(channels)ch \(buffer.format.commonFormat.rawValue)\(buffer.format.isInterleaved ? "i" : "d")"
    lock.unlock()
    guard length > 0, channels > 0, rate > 0 else {
      note(drop: "empty tap buffer or 0 Hz input")
      return
    }
    var source = carry
    source.reserveCapacity(carry.count + length)
    // Deinterleaved: one pointer per channel. Interleaved: one pointer, channels side by side.
    let interleaved = buffer.format.isInterleaved
    let at = { (channel: Int, index: Int) -> (Int, Int) in interleaved ? (0, index * channels + channel) : (channel, index) }
    if let data = buffer.floatChannelData {
      for index in 0..<length {
        var sum: Float = 0
        for channel in 0..<channels {
          let (row, column) = at(channel, index)
          sum += data[row][column]
        }
        source.append(sum / Float(channels))
      }
    } else if let data = buffer.int16ChannelData {
      for index in 0..<length {
        var sum: Float = 0
        for channel in 0..<channels {
          let (row, column) = at(channel, index)
          sum += Float(data[row][column]) / 32768
        }
        source.append(sum / Float(channels))
      }
    } else {
      note(drop: "tap buffer has neither float nor int16 samples")
      return
    }
    let step = rate / micRate
    var position = carryPos
    var out: [Int16] = []
    var energy: Float = 0
    while Int(position + step) <= source.count {
      let start = Int(position)
      let end = max(start + 1, Int(position + step))
      var sum: Float = 0
      for index in start..<end { sum += source[index] }
      let value = max(-1, min(1, sum / Float(end - start)))
      energy += value * value
      out.append(Int16(value * 32767))
      position += step
    }
    let consumed = Int(position)
    carry = Array(source[consumed...])
    carryPos = position - Double(consumed)
    guard !out.isEmpty else { return }
    let count = out.count
    let bytes = out.withUnsafeBufferPointer { Data(buffer: $0) }
    var frames: [String] = []
    lock.lock()
    let silent = muted
    if !silent {
      pending.append(bytes)
      while pending.count >= frameBytes {
        frames.append(pending.prefix(frameBytes).base64EncodedString())
        pending.removeFirst(frameBytes)
      }
    }
    buffersSinceLevel += 1
    let emitLevel = buffersSinceLevel >= 3
    if emitLevel { buffersSinceLevel = 0 }
    lock.unlock()

    for frame in frames {
      sendEvent("audio", ["pcm": frame])
    }
    if !frames.isEmpty {
      lock.lock()
      framesSent += frames.count
      lock.unlock()
    }
    if emitLevel {
      // RMS in dBFS, mapped so speech at a normal distance spans most of 0..1.
      let rms = silent ? 0 : (energy / Float(count)).squareRoot()
      let db = 20 * log10(max(rms, 1e-6))
      sendEvent("level", ["value": min(1, max(0, (db + 50) / 40))])
    }
  }

  private func note(drop reason: String) {
    lock.lock()
    dropped = reason
    lock.unlock()
  }

  /** Host audio (24 kHz PCM16, base64) onto the player, after what is already scheduled. */
  private func schedule(_ base64: String) {
    guard let player, let data = Data(base64Encoded: base64), data.count >= 2 else { return }
    let count = data.count / 2
    guard let buffer = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(count)),
          let channel = buffer.floatChannelData?[0] else { return }
    buffer.frameLength = AVAudioFrameCount(count)
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      let samples = raw.bindMemory(to: Int16.self)
      for index in 0..<count {
        channel[index] = Float(Int16(littleEndian: samples[index])) / 32768
      }
    }
    player.scheduleBuffer(buffer, completionHandler: nil)
  }
}

enum VoiceCallError: Error, CustomStringConvertible {
  case format(String)

  var description: String {
    switch self {
    case .format(let message): return message
    }
  }
}
