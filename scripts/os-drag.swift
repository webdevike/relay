// Posts a real OS left-button drag. Usage: swift scripts/os-drag.swift <x> <y> <dx> <dy>
// Coordinates are global display points, origin top-left (same as Electron screen coords).
// Exits 3 and prints NO_ACCESS when posting events is not permitted. Only the e2e drag spec runs it.
import CoreGraphics
import Foundation

let a = CommandLine.arguments
guard a.count == 5, let x = Double(a[1]), let y = Double(a[2]), let dx = Double(a[3]), let dy = Double(a[4]) else {
  FileHandle.standardError.write("usage: os-drag <x> <y> <dx> <dy>\n".data(using: .utf8)!)
  exit(2)
}
if !CGPreflightPostEventAccess() {
  print("NO_ACCESS")
  exit(3)
}
func post(_ type: CGEventType, _ px: Double, _ py: Double) {
  guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: CGPoint(x: px, y: py), mouseButton: .left) else { return }
  e.post(tap: .cghidEventTap)
}
post(.mouseMoved, x, y)
usleep(100_000)
post(.leftMouseDown, x, y)
usleep(100_000)
for i in 1...10 {
  let f = Double(i) / 10.0
  post(.leftMouseDragged, x + dx * f, y + dy * f)
  usleep(30_000)
}
post(.leftMouseUp, x + dx, y + dy)
usleep(200_000)
print("POSTED")
