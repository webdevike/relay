// Relay Meetings: the meeting recorder Relay ships in Contents/Helpers and runs as its child, so
// macOS charges the System Audio Recording and Microphone grants to Relay.
//
//   RelayMeetingCapture serve --spool DIR [--replay DIR] [--no-detect] [--start-after S] [--end-after S]
//   RelayMeetingCapture list            audio processes and which meeting apps use the mic
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_IGN)

let args = Array(CommandLine.arguments.dropFirst())
func flag(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}

switch args.first {
case "list":
  let procs = audioProcesses()
  for p in procs where p.input || p.output || meetingApp(p.bundle) != nil {
    emit(["pid": Int(p.pid), "bundle": p.bundle, "input": p.input, "output": p.output, "meeting": meetingApp(p.bundle)?.name ?? NSNull()])
  }
  emit(["calls": appsUsingMic(procs).sorted()])
case "serve":
  guard let spool = flag("--spool") else {
    emit(["ev": "error", "message": "serve needs --spool DIR"])
    exit(2)
  }
  // SIGTERM from Relay on quit: stop the recordings so their spools are marked ended.
  let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
  signal(SIGTERM, SIG_IGN)
  let daemon = Daemon(
    spool: URL(fileURLWithPath: spool), replay: flag("--replay").map { URL(fileURLWithPath: $0) },
    detect: !args.contains("--no-detect"),
    startAfter: Double(flag("--start-after") ?? "3") ?? 3, endAfter: Double(flag("--end-after") ?? "15") ?? 15)
  term.setEventHandler { daemon.shutdown() }
  term.resume()
  daemon.run()
default:
  FileHandle.standardError.write("usage: RelayMeetingCapture serve --spool DIR [--replay DIR] [--no-detect] | list\n".data(using: .utf8)!)
  exit(2)
}
