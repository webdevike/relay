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

final class ProcessTap {
  private var tapID = AudioObjectID(kAudioObjectUnknown)
  private var aggID = AudioObjectID(kAudioObjectUnknown)
  private var procID: AudioDeviceIOProcID?
  /// The process objects the tap mixes; empty for the global fallback.
  let scope: Set<AudioObjectID>

  init(track: Track, processes: [AudioProcess]) throws {
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

    guard var asbd = prop(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription()),
      let fmt = AVAudioFormat(streamDescription: &asbd)
    else {
      stop()
      throw TapError(description: "tap format unreadable")
    }
    let q = DispatchQueue(label: "tap.io", qos: .userInteractive)
    err = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, q) { [track] _, inData, inTime, _, _ in
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
