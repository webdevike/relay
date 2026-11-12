import Foundation

/// The run lifecycle of the live call engine, pure (no WebRTC, no audio), so `test/main.swift`
/// tests it with plain swiftc. LiveCallEngine sends it every start, connect, hang up and finish and
/// applies the effects it returns.
///
///   idle --start--> starting(id) --connected--> live(id)
///   starting/live --endRequested, failed, start(next)--> ending(id, pending: next?)
///   ending(id, pending) --finished(id)--> starting(pending.id), or idle
///
/// One run at a time: a start while a run is ending waits (`pending`) until that run has finished,
/// so the old run's audio teardown never lands under the new call. A run replaced while starting
/// or live goes to `ending` and is finished, never dropped. Events naming another run (a stale
/// one) change nothing.
public struct LiveCallLifecycle: Equatable {
  /// A call asked for: the run's id and the assistant.
  public struct Start: Equatable {
    public let id: String
    public let agent: String

    public init(id: String, agent: String) {
      self.id = id
      self.agent = agent
    }
  }

  public enum State: Equatable {
    case idle
    case starting(String)
    case live(String)
    case ending(String, pending: Start?)
  }

  public enum Event: Equatable {
    case start(Start)
    case connected(String)
    case failed(String, kind: String)
    case endRequested(String)
    case finished(String)
  }

  public enum Effect: Equatable {
    /// Connect this run now (audio, Live Activity, peer, host link).
    case beginRun(Start)
    /// Tear this run down (mic, peer, observers, host link, audio, Live Activity); the engine
    /// sends `finished(id)` when that is done.
    case finishRun(String)
    /// This start will never run (another start or a hang up replaced it while it waited).
    case dropStart(String)
  }

  public private(set) var state: State = .idle

  public init() {}

  /// The run `start`, `connected` and the snapshot belong to; nil when idle.
  public var currentId: String? {
    switch state {
    case .idle: return nil
    case .starting(let id), .live(let id), .ending(let id, _): return id
    }
  }

  @discardableResult
  public mutating func send(_ event: Event) -> [Effect] {
    switch (state, event) {
    case (.idle, .start(let next)):
      state = .starting(next.id)
      return [.beginRun(next)]

    case (.starting(let id), .start(let next)), (.live(let id), .start(let next)):
      state = .ending(id, pending: next)
      return [.finishRun(id)]

    case (.ending(let id, let pending), .start(let next)):
      // The newest tap wins; an older queued start never runs.
      state = .ending(id, pending: next)
      return pending.map { [.dropStart($0.id)] } ?? []

    case (.starting(let id), .connected(let run)) where run == id:
      state = .live(id)
      return []

    case (.starting(let id), .failed(let run, _)) where run == id,
      (.starting(let id), .endRequested(let run)) where run == id,
      (.live(let id), .failed(let run, _)) where run == id,
      (.live(let id), .endRequested(let run)) where run == id:
      state = .ending(id, pending: nil)
      return [.finishRun(id)]

    case (.ending(let id, let pending), .endRequested(let run)) where run == id:
      // Hanging up again while a new call waits: that call is hung up too.
      state = .ending(id, pending: nil)
      return pending.map { [.dropStart($0.id)] } ?? []

    case (.starting(let id), .finished(let run)) where run == id,
      (.live(let id), .finished(let run)) where run == id:
      // Torn down without asking first (the engine finishes a run on its own): same as ending.
      state = .idle
      return []

    case (.ending(let id, let pending), .finished(let run)) where run == id:
      guard let pending else {
        state = .idle
        return []
      }
      state = .starting(pending.id)
      return [.beginRun(pending)]

    default:
      // A stale run's event, or one that does not apply in this state.
      return []
    }
  }
}

extension LiveCallLifecycle {
  /// One row of the transition table: the docs diagram is drawn from these, and the tests check
  /// each row against `send`. `guarded` names the condition; "own run" means the event names the
  /// current run (any other run's event is stale and ignored).
  public struct Transition: Equatable {
    public let from: String
    public let event: String
    public let guarded: String?
    public let to: String
  }

  public static let transitions: [Transition] = [
    Transition(from: "idle", event: "start", guarded: nil, to: "starting"),
    Transition(from: "starting", event: "connected", guarded: "own run", to: "live"),
    Transition(from: "starting", event: "start", guarded: nil, to: "ending"),
    Transition(from: "starting", event: "failed", guarded: "own run", to: "ending"),
    Transition(from: "starting", event: "endRequested", guarded: "own run", to: "ending"),
    Transition(from: "starting", event: "finished", guarded: "own run", to: "idle"),
    Transition(from: "live", event: "start", guarded: nil, to: "ending"),
    Transition(from: "live", event: "failed", guarded: "own run", to: "ending"),
    Transition(from: "live", event: "endRequested", guarded: "own run", to: "ending"),
    Transition(from: "live", event: "finished", guarded: "own run", to: "idle"),
    Transition(from: "ending", event: "start", guarded: nil, to: "ending"),
    Transition(from: "ending", event: "endRequested", guarded: "own run", to: "ending"),
    Transition(from: "ending", event: "finished", guarded: "own run, a start waits", to: "starting"),
    Transition(from: "ending", event: "finished", guarded: "own run, none waits", to: "idle"),
  ]

  /// The name of a state, as the table uses it.
  public static func name(of state: State) -> String {
    switch state {
    case .idle: return "idle"
    case .starting: return "starting"
    case .live: return "live"
    case .ending: return "ending"
    }
  }

  /// The Mermaid diagram of `transitions`, for docs/state-machines/live-call-lifecycle.md.
  public static var mermaid: String {
    var lines = ["```mermaid", "stateDiagram-v2", "  [*] --> idle"]
    for t in transitions {
      lines.append("  \(t.from) --> \(t.to) : \(t.event)" + (t.guarded.map { " [\($0)]" } ?? ""))
    }
    lines.append("```")
    return lines.joined(separator: "\n")
  }
}
