// Tests for LiveCallLiveness, compiled with it by `pnpm test:native` (swiftc on the Mac; no
// simulator, no WebRTC). Exits non-zero on the first failure.

import Foundation

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

if failures > 0 {
  print("\(failures) failed")
  exit(1)
}
print("all passed")
