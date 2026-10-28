// The Live Activity of a live call (lock screen banner and Dynamic Island). This one file is
// compiled into the LiveCall module, which starts, updates and ends the activity, and into the
// Live Activity widget extension (targets/live-call/LiveCallAttributes.swift is a symlink to it),
// which draws it: ActivityKit pairs the two by type name and Codable shape, so they must never
// drift apart.

import ActivityKit
import Foundation

public struct LiveCallAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    /// `connecting`, `listening`, `thinking`, `speaking` or `ended`.
    public var state: String
    /// The latest words of the conversation (the assistant's, or Isaac's prefixed "You: "), or why it ended.
    public var line: String
    public var startedAt: Date

    public init(state: String, line: String, startedAt: Date) {
      self.state = state
      self.line = line
      self.startedAt = startedAt
    }
  }

  /// Assistant id (`nova`, `astra`).
  public var agent: String
  /// What the banner calls it ("Nova").
  public var agentName: String

  public init(agent: String, agentName: String) {
    self.agent = agent
    self.agentName = agentName
  }
}
