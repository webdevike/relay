import Foundation
import RelayProtocol

enum SnapshotBuilder {
    static func build(
        macName: String,
        version: String,
        accessibility: AccessibilityChecking,
        agents: AgentProvider?,
        agentsTracker: AgentsDeltaTracker
    ) -> Snapshot {
        Snapshot(
            mac: MacState(
                name: macName,
                version: version,
                accessibilityGranted: accessibility.isTrusted,
                agentsAvailable: agents?.isAvailable ?? false
            ),
            agents: AgentsSnapshot(rev: agentsTracker.rev, sessions: agentsTracker.sessions)
        )
    }
}
