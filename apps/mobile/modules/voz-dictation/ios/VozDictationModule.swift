// Hold-to-talk recognizer on Desert Ant's Voz (NVIDIA Parakeet TDT 0.6B on the Neural Engine).
// Voz transcribes finished audio, not a stream, so the module records the microphone into memory
// while the finger is down and hands the whole clip to the model on `stop`. `level` events feed
// the listening orb meanwhile; JS sees one transcript at the end instead of partials.
//
// `start`, `stop` and `abort` open and close the microphone in call order on one serial queue: a
// tap (start and stop in the same instant) used to let `stop`, which ran on its own task, finish
// before `start` opened the engine, and the microphone then stayed open with nothing to close it.
// Closing hands the audio session back as playback only, deactivated.

import AVFoundation
import ExpoModulesCore
import Voz

public class VozDictationModule: Module {
  private var voz: Voz?
  private var engine: AVAudioEngine?
  private var samples: [Float] = []
  private var sampleRate: Double = 0
  private var buffersSinceLevel = 0
  private let lock = NSLock()
  /** Owns `engine` and `sessionOwned`; see the header. */
  private let queue = DispatchQueue(label: "relay.voz-dictation", qos: .userInitiated)
  /** Whether recording switched the audio session to record and has not handed it back yet. */
  private var sessionOwned = false

  public func definition() -> ModuleDefinition {
    Name("VozDictation")
    Events("level", "downloadProgress")

    Function("isDownloaded") { () -> Bool in
      Voz.isDownloaded()
    }

    AsyncFunction("download") { () async throws in
      try await Voz.download { progress in
        self.sendEvent("downloadProgress", ["fraction": progress.fraction])
      }
    }

    /// Loads the model (first load after a download pays ~20 s of Neural Engine specialization).
    AsyncFunction("prepare") { () async throws in
      _ = try await self.model()
    }

    AsyncFunction("requestPermission") { () async -> Bool in
      await AVAudioApplication.requestRecordPermission()
    }

    AsyncFunction("start") { () throws in
      try self.startRecording()
    }.runOnQueue(queue)

    /// Stops the microphone and returns the transcript of everything heard since `start`.
    AsyncFunction("stop") { () async throws -> String in
      let (clip, rate) = await withCheckedContinuation { continuation in
        self.queue.async { continuation.resume(returning: self.stopRecording()) }
      }
      guard !clip.isEmpty else { return "" }
      let voz = try await self.model()
      return try await voz.transcribe(samples: clip, sampleRate: rate).text
    }

    Function("abort") {
      self.queue.async { _ = self.stopRecording() }
    }

    OnDestroy {
      self.queue.sync { _ = self.stopRecording() }
    }
  }

  private func model() async throws -> Voz {
    if let voz { return voz }
    let loaded = try await Voz()
    voz = loaded
    return loaded
  }

  private func startRecording() throws {
    _ = stopRecording()
    do {
      try openRecording()
    } catch {
      _ = stopRecording()
      throw error
    }
  }

  private func openRecording() throws {
    let session = AVAudioSession.sharedInstance()
    sessionOwned = true
    try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
    try session.setActive(true)
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    lock.lock()
    samples.removeAll(keepingCapacity: true)
    sampleRate = format.sampleRate
    buffersSinceLevel = 0
    lock.unlock()
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      self?.ingest(buffer)
    }
    // Held before it starts, so a failed start is torn down like any other.
    self.engine = engine
    engine.prepare()
    try engine.start()
  }

  /// Tears the microphone down, hands the session back, and returns the clip (mono) with its sample rate.
  private func stopRecording() -> ([Float], Double) {
    if let engine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
      self.engine = nil
    }
    if sessionOwned {
      sessionOwned = false
      let session = AVAudioSession.sharedInstance()
      try? session.setCategory(.playback, mode: .default, options: [])
      try? session.setActive(false, options: [.notifyOthersOnDeactivation])
    }
    lock.lock()
    let clip = samples
    let rate = sampleRate
    samples = []
    lock.unlock()
    return (clip, rate)
  }

  private func ingest(_ buffer: AVAudioPCMBuffer) {
    guard let channels = buffer.floatChannelData else { return }
    let frames = Int(buffer.frameLength)
    if frames == 0 { return }
    let mono = UnsafeBufferPointer(start: channels[0], count: frames)
    var energy: Float = 0
    for sample in mono { energy += sample * sample }
    lock.lock()
    samples.append(contentsOf: mono)
    buffersSinceLevel += 1
    let emit = buffersSinceLevel >= 3
    if emit { buffersSinceLevel = 0 }
    lock.unlock()
    if emit {
      // RMS in dBFS, mapped so speech at a normal distance spans most of 0..1.
      let rms = (energy / Float(frames)).squareRoot()
      let db = 20 * log10(max(rms, 1e-6))
      let level = min(1, max(0, (db + 50) / 40))
      sendEvent("level", ["value": level])
    }
  }
}
