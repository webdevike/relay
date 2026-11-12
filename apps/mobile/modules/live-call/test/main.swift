// Tests for LiveCallLiveness and LiveCallLifecycle, compiled with them by `pnpm test:native`
// (swiftc on the Mac; no simulator, no WebRTC). Exits non-zero on the first failure.

import Foundation

// `--mermaid`: print LiveCallLifecycle's diagram for scripts/test-native.sh and stop.
if CommandLine.arguments.contains("--mermaid") {
  print(LiveCallLifecycle.mermaid)
  exit(0)
}

var failures = 0

func expect(_ actual: LiveCallLiveness.Verdict, _ expected: LiveCallLiveness.Verdict, _ name: String, line: Int = #line) {
  if actual == expected {
    print("ok   \(name)")
  } else {
    failures += 1
    print("FAIL \(name) (line \(line)): got \(actual), want \(expected)")
  }
}

let t0 = Date(timeIntervalSince1970: 1_000_000)
func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }
let grace = LiveCallLiveness.reconnectGrace
let silence = LiveCallLiveness.silenceLimit

do {
  var l = LiveCallLiveness(now: t0)
  for second in stride(from: 10.0, through: 600.0, by: 10.0) {
    l.heard(at: at(second))
  }
  expect(l.verdict(at: at(600)), .live, "a call that keeps hearing stays live")
}

do {
  var l = LiveCallLiveness(now: t0)
  l.hostLost(at: at(5))
  expect(l.verdict(at: at(5)), .reconnecting, "host link lost: reconnecting at once")
  l.heard(at: at(10))
  expect(l.verdict(at: at(5 + grace - 0.1)), .reconnecting, "audio still flowing does not cancel the host grace")
  expect(l.verdict(at: at(5 + grace)), .end("Lost the connection to your Mac"), "host link gone for the whole grace: ends")
}

do {
  var l = LiveCallLiveness(now: t0)
  l.hostLost(at: at(5))
  l.hostLost(at: at(15))
  expect(l.verdict(at: at(5 + grace)), .end("Lost the connection to your Mac"), "a repeated loss does not restart the grace")
}

do {
  var l = LiveCallLiveness(now: t0)
  l.hostLost(at: at(5))
  l.hostBack(at: at(12))
  expect(l.verdict(at: at(12)), .live, "host link back within the grace: live again")
  expect(l.verdict(at: at(5 + grace + 1)), .live, "and the old grace no longer ends it")
}

do {
  var l = LiveCallLiveness(now: t0)
  l.peerLost(at: at(30))
  expect(l.verdict(at: at(31)), .reconnecting, "WebRTC disconnected: reconnecting")
  l.peerBack(at: at(40))
  expect(l.verdict(at: at(41)), .live, "WebRTC back: live")
  l.peerLost(at: at(50))
  expect(l.verdict(at: at(50 + grace)), .end("Lost the voice connection"), "WebRTC gone for the whole grace: ends")
}

do {
  var l = LiveCallLiveness(now: t0)
  l.peerLost(at: at(1))
  l.hostLost(at: at(2))
  expect(l.verdict(at: at(1 + grace)), .end("Lost the voice connection"), "both lost: the voice ends it first")
}

do {
  var l = LiveCallLiveness(now: t0)
  l.heard(at: at(100))
  expect(l.verdict(at: at(100 + silence - 1)), .live, "quiet but under the silence limit: live")
  expect(l.verdict(at: at(100 + silence)), .end("The call stopped responding"), "nothing heard for the silence limit: ends")
}

do {
  // The app was suspended for 20 minutes mid-call and wakes: the first check ends it.
  var l = LiveCallLiveness(now: t0)
  l.heard(at: at(78))
  expect(l.verdict(at: at(78 + 20 * 60)), .end("The call stopped responding"), "woken after a long suspension: ends")
}

do {
  var l = LiveCallLiveness(now: t0)
  l.heard(at: at(50))
  l.heard(at: at(20))
  expect(l.verdict(at: at(50 + silence - 1)), .live, "an out-of-order heard does not move the clock back")
}

func same<T: Equatable>(_ actual: T, _ expected: T, _ name: String, line: Int = #line) {
  if actual == expected {
    print("ok   \(name)")
  } else {
    failures += 1
    print("FAIL \(name) (line \(line)): got \(actual), want \(expected)")
  }
}

// The host's grace (LIVE_RECONNECT_GRACE_MS in packages/protocol), passed in by test-native.sh.
if let ms = ProcessInfo.processInfo.environment["LIVE_RECONNECT_GRACE_MS"].flatMap(Double.init) {
  same(grace, ms / 1000, "reconnectGrace matches the protocol's LIVE_RECONNECT_GRACE_MS")
} else {
  failures += 1
  print("FAIL LIVE_RECONNECT_GRACE_MS not given: run through scripts/test-native.sh")
}

typealias Lifecycle = LiveCallLifecycle
func call(_ id: String) -> Lifecycle.Start { Lifecycle.Start(id: id, agent: "eva") }

do {
  var m = Lifecycle()
  same(m.send(.start(call("a"))), [.beginRun(call("a"))], "idle start begins the run")
  same(m.send(.connected("a")), [], "connected")
  same(m.state, .live("a"), "live")
  same(m.send(.endRequested("a")), [.finishRun("a")], "hang up finishes the run")
  same(m.send(.finished("a")), [], "finished")
  same(m.state, .idle, "back to idle")
}

do {
  var m = Lifecycle()
  m.send(.start(call("a")))
  m.send(.connected("a"))
  m.send(.endRequested("a"))
  same(m.send(.start(call("b"))), [], "end then start: the start waits, nothing begins")
  same(m.state, .ending("a", pending: call("b")), "queued behind the ending run")
  same(m.send(.connected("b")), [], "the queued run's events do nothing before it begins")
  same(m.send(.finished("a")), [.beginRun(call("b"))], "it begins once the old run has finished")
  same(m.state, .starting("b"), "starting the new run")
}

do {
  // Three overlapping starts: one run left, every replaced run finished.
  var m = Lifecycle()
  var begun: [String] = []
  var finishing: [String] = []
  var dropped: [String] = []
  func run(_ effects: [Lifecycle.Effect]) {
    for effect in effects {
      switch effect {
      case .beginRun(let s): begun.append(s.id)
      case .finishRun(let id): finishing.append(id)
      case .dropStart(let id): dropped.append(id)
      }
    }
  }
  run(m.send(.start(call("a"))))
  run(m.send(.start(call("b"))))
  run(m.send(.start(call("c"))))
  same(finishing, ["a"], "the starting run is finished, not dropped")
  same(dropped, ["b"], "the older queued start never runs")
  run(m.send(.finished("a")))
  same(begun, ["a", "c"], "exactly one new run begins: the newest")
  same(m.state, .starting("c"), "c is the run")
  run(m.send(.start(call("d"))))
  same(finishing, ["a", "c"], "replacing a starting run finishes it")
  run(m.send(.finished("c")))
  same(begun, ["a", "c", "d"], "then the next begins")
  same(Set(finishing + dropped).union(["d"]), Set(["a", "b", "c", "d"]), "every replaced run finished or dropped")
}

do {
  var m = Lifecycle()
  m.send(.start(call("a")))
  m.send(.start(call("b")))
  m.send(.finished("a"))
  same(m.send(.connected("a")), [], "a stale run's connected is ignored")
  same(m.send(.failed("a", kind: "fallback")), [], "a stale run's failure is ignored")
  same(m.send(.endRequested("a")), [], "a stale run's hang up is ignored")
  same(m.send(.finished("a")), [], "a stale run's finish is ignored")
  same(m.state, .starting("b"), "the current run is untouched")
}

do {
  var m = Lifecycle()
  m.send(.start(call("a")))
  same(m.send(.failed("a", kind: "fallback")), [.finishRun("a")], "a failed start is finished")
  m.send(.start(call("b")))
  same(m.send(.endRequested("a")), [.dropStart("b")], "hanging up while a call waits drops it")
  same(m.send(.finished("a")), [], "nothing begins")
  same(m.state, .idle, "idle")
}

do {
  // Every row of the transition table (the docs diagram) is what `send` does.
  func machine(in state: String, waiting: Bool) -> Lifecycle {
    var m = Lifecycle()
    if state == "idle" { return m }
    m.send(.start(call("a")))
    if state == "live" { m.send(.connected("a")) }
    if state == "ending" {
      m.send(.endRequested("a"))
      if waiting { m.send(.start(call("w"))) }
    }
    return m
  }
  func event(_ name: String) -> Lifecycle.Event {
    switch name {
    case "start": return .start(call("n"))
    case "connected": return .connected("a")
    case "failed": return .failed("a", kind: "fallback")
    case "endRequested": return .endRequested("a")
    default: return .finished("a")
    }
  }
  for t in Lifecycle.transitions {
    var m = machine(in: t.from, waiting: t.guarded?.contains("a start waits") == true)
    same(Lifecycle.name(of: m.state), t.from, "table row starts in \(t.from)")
    m.send(event(t.event))
    same(Lifecycle.name(of: m.state), t.to, "table: \(t.from) --\(t.event)--> \(t.to)")
  }
  // Anything not in the table leaves the state alone, and a stale run's events always do.
  let names = ["start", "connected", "failed", "endRequested", "finished"]
  for from in ["idle", "starting", "live", "ending"] {
    for name in names where !Lifecycle.transitions.contains(where: { $0.from == from && $0.event == name }) {
      var m = machine(in: from, waiting: false)
      let before = m.state
      m.send(event(name))
      same(m.state, before, "not in the table: \(from) ignores \(name)")
    }
    for stale: Lifecycle.Event in [.connected("x"), .failed("x", kind: "k"), .endRequested("x"), .finished("x")] {
      var m = machine(in: from, waiting: true)
      let before = m.state
      m.send(stale)
      same(m.state, before, "\(from) ignores a stale run's \(stale)")
    }
  }
}

if failures > 0 {
  print("\(failures) failed")
  exit(1)
}
print("all passed")
