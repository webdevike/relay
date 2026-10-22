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
  private var converter: AVAudioConverter?
  private var pending = Data()
  private var muted = false
  private var buffersSinceLevel = 0
  private var interruption: NSObjectProtocol?
  /** Guards `pending`, `muted` and `buffersSinceLevel`, touched from the audio thread and from JS. */
  private let lock = NSLock()
  private let micFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: micRate, channels: 1, interleaved: true)!
  private let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: playRate, channels: 1, interleaved: false)!

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
    try input.setVoiceProcessingEnabled(true)
    let player = AVAudioPlayerNode()
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: playFormat)

    let hardware = input.outputFormat(forBus: 0)
    guard let converter = AVAudioConverter(from: hardware, to: micFormat) else {
      throw VoiceCallError.format("cannot convert \(hardware) to 16 kHz mono")
    }
    converter.downmix = true
    lock.lock()
    pending.removeAll()
    muted = false
    buffersSinceLevel = 0
    lock.unlock()
    input.installTap(onBus: 0, bufferSize: 1024, format: hardware) { [weak self] buffer, _ in
      self?.ingest(buffer)
    }
    engine.prepare()
    try engine.start()
    player.play()
    self.engine = engine
    self.player = player
    self.converter = converter
    interruption = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification, object: session, queue: .main
    ) { [weak self] note in
      let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
      if raw == AVAudioSession.InterruptionType.began.rawValue {
        self?.sendEvent("interrupted", [:])
      }
    }
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
    self.converter = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
  }

  /** Microphone buffer (audio thread): convert to 16 kHz PCM16, send whole 100 ms frames. */
  private func ingest(_ buffer: AVAudioPCMBuffer) {
    guard let converter else { return }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * micRate / buffer.format.sampleRate) + 64
    guard let out = AVAudioPCMBuffer(pcmFormat: micFormat, frameCapacity: capacity) else { return }
    var given = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if given {
        status.pointee = .noDataNow
        return nil
      }
      given = true
      status.pointee = .haveData
      return buffer
    }
    guard error == nil, out.frameLength > 0, let samples = out.int16ChannelData else { return }
    let count = Int(out.frameLength)
    var energy: Float = 0
    for index in 0..<count {
      let value = Float(samples[0][index]) / 32768
      energy += value * value
    }
    let bytes = Data(bytes: samples[0], count: count * 2)

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
    if emitLevel {
      // RMS in dBFS, mapped so speech at a normal distance spans most of 0..1.
      let rms = silent ? 0 : (energy / Float(count)).squareRoot()
      let db = 20 * log10(max(rms, 1e-6))
      sendEvent("level", ["value": min(1, max(0, (db + 50) / 40))])
    }
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
