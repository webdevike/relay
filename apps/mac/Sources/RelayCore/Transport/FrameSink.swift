import Foundation
import RelayProtocol

/// Where a `ClientSession` sends outbound frames. The real implementation writes a WebSocket text
/// frame on the connection; tests inject a recording fake.
protocol FrameSink: AnyObject {
    func send(_ message: ServerMessage)
}
