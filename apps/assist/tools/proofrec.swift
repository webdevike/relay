// proofrec: record the main display with ScreenCaptureKit, keeping only the windows of the
// given processes (for example Blender + Relay Buddy). Works while the Mac is locked, because
// it records those windows themselves rather than the lock screen above them.
//
//   swiftc -O -o build/proofrec tools/proofrec.swift
//   build/proofrec <out.mov> <seconds> <pid> [<pid> ...]
//   PROOFREC_AUDIO=1 also records the included apps' audio (ScreenCaptureKit, no extra permission).
import AVFoundation
import Foundation
import ScreenCaptureKit

final class Recorder: NSObject, SCRecordingOutputDelegate {
    private let finished = DispatchSemaphore(value: 0)

    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) { finished.signal() }

    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        FileHandle.standardError.write(Data("recording failed: \(error)\n".utf8))
        finished.signal()
    }

    func run(output: URL, seconds: Double, pids: Set<pid_t>) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let apps = content.applications.filter { pids.contains($0.processID) }
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            throw NSError(domain: "proofrec", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display"])
        }
        print("recording display \(display.width)x\(display.height), apps: \(apps.map { "\($0.applicationName) (\($0.processID))" })")
        let filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.width = display.width
        config.height = display.height
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.showsCursor = false
        if ProcessInfo.processInfo.environment["PROOFREC_AUDIO"] == "1" {
            config.capturesAudio = true
            config.sampleRate = 48000
            config.channelCount = 2
        }
        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        let recordingConfig = SCRecordingOutputConfiguration()
        try? FileManager.default.removeItem(at: output)
        recordingConfig.outputURL = output
        recordingConfig.outputFileType = .mov
        recordingConfig.videoCodecType = .h264
        let recording = SCRecordingOutput(configuration: recordingConfig, delegate: self)
        try stream.addRecordingOutput(recording)
        try await stream.startCapture()
        // Windows that appear later (Buddy's overlay) join the recording: refresh the app set.
        var included = Set(apps.map(\.processID))
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            try await Task.sleep(nanoseconds: 250_000_000)
            guard let now = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) else { continue }
            let current = now.applications.filter { pids.contains($0.processID) }
            let ids = Set(current.map(\.processID))
            if ids != included {
                included = ids
                try await stream.updateContentFilter(SCContentFilter(display: display, including: current, exceptingWindows: []))
                print("now recording: \(current.map(\.applicationName))")
            }
        }
        try await stream.stopCapture()
        _ = finished.wait(timeout: .now() + 5)
        print("saved \(output.path)")
    }
}

let args = CommandLine.arguments
guard args.count >= 4, let seconds = Double(args[2]) else {
    print("usage: proofrec <out.mov> <seconds> <pid> [<pid> ...]")
    exit(2)
}
let pids = Set(args[3...].compactMap { pid_t($0) })
let recorder = Recorder()
Task {
    do {
        try await recorder.run(output: URL(fileURLWithPath: args[1]), seconds: seconds, pids: pids)
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("proofrec: \(error)\n".utf8))
        exit(1)
    }
}
RunLoop.main.run()
