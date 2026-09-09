import Foundation
import RelayProtocol

/// Server-wide, shared across every authenticated session: the last published agent-session list
/// plus a monotonically increasing `rev`. `seed` establishes the baseline used by `welcome` and
/// `agents.get` (no rev bump). `apply` diffs a new list against the baseline, by id and
/// `Equatable`, and bumps `rev` for a broadcastable `agents.delta`.
final class AgentsDeltaTracker {
    private(set) var rev = 0
    private(set) var sessions: [AgentSession] = []

    func seed(_ newSessions: [AgentSession]) {
        sessions = newSessions
    }

    func apply(_ newSessions: [AgentSession]) -> ServerMessage {
        let previousById = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
        let newIds = Set(newSessions.map(\.id))
        let upsert = newSessions.filter { previousById[$0.id] != $0 }
        let remove = sessions.map(\.id).filter { !newIds.contains($0) }
        rev += 1
        sessions = newSessions
        return .agentsDelta(rev: rev, upsert: upsert.isEmpty ? nil : upsert, remove: remove.isEmpty ? nil : remove)
    }
}
