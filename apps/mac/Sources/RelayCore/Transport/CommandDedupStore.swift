import Foundation
import RelayProtocol

/// Dedups `cmd` execution by id, per device, across reconnects: a phone retries un-acked commands
/// after reconnecting, and the Mac must answer with the original response instead of re-executing.
/// Keeps the last 256 ids per device (oldest evicted first). Owned by `RelayServer`, shared by
/// every `ClientSession` for that server so an entry outlives any one connection.
///
/// Atomic across an `await`: a command whose execution is asynchronous (e.g. `agent.reply`) is
/// marked in-flight synchronously in `begin`, before any suspension point. A duplicate id that
/// arrives while the original is still in flight is never re-executed; it registers as a waiter
/// and is sent the eventual response by `complete`.
final class CommandDedupStore {
    enum LookupResult {
        /// Never seen before: the caller must execute and later call `complete`.
        case fresh
        /// The original call for this id is still running; `waiter` will be sent the response by
        /// `complete`. The caller must not execute again.
        case inFlight
        /// Already finished: resend the cached response.
        case completed(ServerMessage)
    }

    private enum State {
        case inFlight(waiters: [FrameSink])
        case completed(ServerMessage)
    }

    private struct Entry {
        let id: String
        var state: State
    }

    private let capacity = 256
    private var byDevice: [String: [Entry]] = [:]

    func begin(deviceId: String, id: String, waiter: FrameSink) -> LookupResult {
        var entries = byDevice[deviceId] ?? []
        if let index = entries.firstIndex(where: { $0.id == id }) {
            switch entries[index].state {
            case let .completed(response):
                return .completed(response)
            case var .inFlight(waiters):
                waiters.append(waiter)
                entries[index].state = .inFlight(waiters: waiters)
                byDevice[deviceId] = entries
                return .inFlight
            }
        }
        entries.append(Entry(id: id, state: .inFlight(waiters: [])))
        if entries.count > capacity {
            entries.removeFirst(entries.count - capacity)
        }
        byDevice[deviceId] = entries
        return .fresh
    }

    /// Notifies every waiter that registered while `id` was in flight, then stores `response` for
    /// future dedup lookups. Does not send to the original caller; the caller sends to itself.
    func complete(deviceId: String, id: String, response: ServerMessage) {
        guard var entries = byDevice[deviceId], let index = entries.firstIndex(where: { $0.id == id }) else {
            return
        }
        if case let .inFlight(waiters) = entries[index].state {
            for waiter in waiters { waiter.send(response) }
        }
        entries[index].state = .completed(response)
        byDevice[deviceId] = entries
    }
}
