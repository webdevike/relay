import Foundation
import RelayProtocol

/// Dedups `cmd` execution by id, per device, across reconnects: a phone retries un-acked commands
/// after reconnecting, and the Mac must answer with the original response instead of re-executing.
/// Keeps the last 256 responses per device (oldest evicted first). Owned by `RelayServer`, shared
/// by every `ClientSession` for that server so a dedup entry outlives any one connection.
final class CommandDedupStore {
    private struct Entry {
        let id: String
        let response: ServerMessage
    }

    private let capacity = 256
    private var byDevice: [String: [Entry]] = [:]

    func response(deviceId: String, id: String) -> ServerMessage? {
        byDevice[deviceId]?.first { $0.id == id }?.response
    }

    func record(deviceId: String, id: String, response: ServerMessage) {
        var entries = byDevice[deviceId] ?? []
        entries.removeAll { $0.id == id }
        entries.append(Entry(id: id, response: response))
        if entries.count > capacity {
            entries.removeFirst(entries.count - capacity)
        }
        byDevice[deviceId] = entries
    }
}
