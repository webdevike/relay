// Call audio through a Core Audio process tap on a private aggregate device. Scoped to the meeting
// app's processes, so notification sounds and music stay out; everything the Mac plays except this
// helper when the app has no audio process yet. Private and unmuted: the call still plays normally.
// While the System Audio Recording grant is pending or denied the tap delivers silence, not an
// error (the health check catches that).
import AVFoundation
import CoreAudio
import Foundation

struct TapError: Error, CustomStringConvertible {
  let description: String
}

/// The rate the aggregate's IO buffers really carry. The tap's own format says 48 kHz even when the
/// clock device runs slower (AirPods in call mode), and labelling those buffers 48 kHz wrote the
/// call at double speed and half length (2026-11-05). Starts at the aggregate's nominal rate and
/// follows the device's sample clock (`mSampleTime` against host time) after that, snapped to a
/// standard rate. Only touched on the IO queue.
final class TapClock {
  static let standard: [Double] = [8_000, 11_025, 12_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000]
  private(set) var rate: Double
  private var winHost: UInt64 = 0
  private var winSample: Double = 0

  init(rate: Double) { self.rate = rate }

  /// Feeds one IO timestamp; answers the new rate when the measured one differs by over 5%.
  func observe(sampleTime: Double, hostTime: UInt64) -> Double? {
    guard hostTime > 0 else { return nil }
    if winHost == 0 || hostTime <= winHost || sampleTime < winSample {
      winHost = hostTime
      winSample = sampleTime
      return nil
    }
    let dt = AVAudioTime.seconds(forHostTime: hostTime - winHost)
    guard dt >= 2 else { return nil }
    let measured = (sampleTime - winSample) / dt
    winHost = hostTime
    winSample = sampleTime
    return adopt(measured)
  }

  func adopt(_ measured: Double) -> Double? {
    guard measured > 1_000 else { return nil }
    let snapped = Self.standard.min { abs($0 - measured) < abs($1 - measured) }!
    guard abs(snapped - rate) / rate > 0.05 else { return nil }
    rate = snapped
    return snapped
  }
}

final class ProcessTap {
  private var tapID = AudioObjectID(kAudioObjectUnknown)
  private var aggID = AudioObjectID(kAudioObjectUnknown)
  private var procID: AudioDeviceIOProcID?
  /// The process objects the tap mixes; empty for the global fallback.
  let scope: Set<AudioObjectID>

  /// `note` hears rate changes (for the recording's warnings), from the IO queue.
  init(track: Track, processes: [AudioProcess], note: @escaping (String) -> Void = { _ in }) throws {
    let ownPID = ProcessInfo.processInfo.processIdentifier
    let desc: CATapDescription
    if processes.isEmpty {
      let own = audioProcesses().filter { $0.pid == ownPID }.map(\.object)
      desc = CATapDescription(stereoGlobalTapButExcludeProcesses: own)
      scope = []
    } else {
      desc = CATapDescription(stereoMixdownOfProcesses: processes.map(\.object))
      scope = Set(processes.map(\.object))
    }
    desc.uuid = UUID()
    desc.name = "Relay meeting tap"
    desc.isPrivate = true
    desc.muteBehavior = .unmuted
    var err = AudioHardwareCreateProcessTap(desc, &tapID)
    guard err == noErr else { throw TapError(description: "AudioHardwareCreateProcessTap \(err)") }

    let outputID = prop(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, AudioObjectID(0)) ?? 0
    let outputUID = propString(outputID, kAudioDevicePropertyDeviceUID) ?? ""
    let agg: [String: Any] = [
      kAudioAggregateDeviceNameKey: "Relay meeting tap",
      kAudioAggregateDeviceUIDKey: UUID().uuidString,
      kAudioAggregateDeviceMainSubDeviceKey: outputUID,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
      kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: desc.uuid.uuidString]],
    ]
    err = AudioHardwareCreateAggregateDevice(agg as CFDictionary, &aggID)
    guard err == noErr else {
      AudioHardwareDestroyProcessTap(tapID)
      throw TapError(description: "AudioHardwareCreateAggregateDevice \(err)")
    }

    guard let tapFormat = prop(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription()),
      tapFormat.mSampleRate > 0
    else {
      stop()
      throw TapError(description: "tap format unreadable")
    }
    let nominal = prop(aggID, kAudioDevicePropertyNominalSampleRate, Float64(0)) ?? 0
    let clock = TapClock(rate: nominal > 0 ? nominal : tapFormat.mSampleRate)
    if clock.rate != tapFormat.mSampleRate {
      note("call audio runs at \(Int(clock.rate)) Hz (the tap says \(Int(tapFormat.mSampleRate)) Hz)")
    }
    func format(_ rate: Double) -> AVAudioFormat? {
      var asbd = tapFormat
      asbd.mSampleRate = rate
      return AVAudioFormat(streamDescription: &asbd)
    }
    guard var fmt = format(clock.rate) else {
      stop()
      throw TapError(description: "tap format unusable")
    }
    let q = DispatchQueue(label: "tap.io", qos: .userInteractive)
    err = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, q) { [track] _, inData, inTime, _, _ in
      let ts = inTime.pointee
      if ts.mFlags.contains(.sampleTimeValid), ts.mFlags.contains(.hostTimeValid),
        let rate = clock.observe(sampleTime: ts.mSampleTime, hostTime: ts.mHostTime), let next = format(rate)
      {
        fmt = next
        note("call audio now runs at \(Int(rate)) Hz")
      }
      let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inData))
      guard let first = list.first, first.mDataByteSize > 0 else { return }
      let frames = AVAudioFrameCount(first.mDataByteSize / fmt.streamDescription.pointee.mBytesPerFrame)
      guard let copy = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames) else { return }
      copy.frameLength = frames
      let dst = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
      for (i, b) in list.enumerated() where i < dst.count {
        memcpy(dst[i].mData, b.mData, Int(b.mDataByteSize))
      }
      let host = inTime.pointee.mHostTime
      track.queue.async { track.push(copy, hostTime: host) }
    }
    guard err == noErr else {
      stop()
      throw TapError(description: "AudioDeviceCreateIOProcIDWithBlock \(err)")
    }
    err = AudioDeviceStart(aggID, procID)
    guard err == noErr else {
      stop()
      throw TapError(description: "AudioDeviceStart \(err)")
    }
  }

  func stop() {
    if let procID {
      AudioDeviceStop(aggID, procID)
      AudioDeviceDestroyIOProcID(aggID, procID)
    }
    procID = nil
    if aggID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggID) }
    if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
    aggID = AudioObjectID(kAudioObjectUnknown)
    tapID = AudioObjectID(kAudioObjectUnknown)
  }
}
