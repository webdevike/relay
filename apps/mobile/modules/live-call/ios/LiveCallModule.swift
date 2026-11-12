// JS face of LiveCallEngine (see LiveCallEngine.swift). The App Intents use the engine directly;
// this module also reports calls they started, so the app shows them when it opens.

import ExpoModulesCore

struct LiveCallHostRecord: Record {
  @Field var url: String = ""
  @Field var deviceId: String = ""
  @Field var deviceName: String = ""
  @Field var secretHex: String = ""
  @Field var name: String = ""
}

struct LiveCallConfigureOptions: Record {
  @Field var hosts: [LiveCallHostRecord] = []
}

public class LiveCallModule: Module {
  // `current()` reads LiveCallCurrent, which the engine writes itself: binding the events below
  // happens in a Task after OnCreate, too late for a JS reload that asks at once.

  public func definition() -> ModuleDefinition {
    Name("LiveCall")
    Events("state", "fallback")

    OnCreate { [weak self] in
      Task { @MainActor in
        let engine = LiveCallEngine.shared
        engine.onState = { snapshot in
          self?.sendEvent("state", snapshot.dictionary)
        }
        engine.onFallback = { agent, reason in
          self?.sendEvent("fallback", ["agent": agent, "reason": reason])
        }
      }
    }

    Function("configure") { (options: LiveCallConfigureOptions) in
      let hosts = options.hosts.map {
        LiveCallHost(url: $0.url, deviceId: $0.deviceId, deviceName: $0.deviceName, secretHex: $0.secretHex, name: $0.name)
      }
      Task { @MainActor in
        LiveCallEngine.shared.configure(hosts: hosts)
      }
    }

    AsyncFunction("start") { (agent: String) async -> [String: Any] in
      let outcome = await LiveCallEngine.shared.start(agent: agent)
      var result: [String: Any] = ["outcome": outcome.name]
      if let message = outcome.message { result["message"] = message }
      return result
    }

    AsyncFunction("end") { () async in
      await LiveCallEngine.shared.end()
    }

    Function("setMuted") { (muted: Bool) in
      Task { @MainActor in
        LiveCallEngine.shared.setMuted(muted)
      }
    }

    Function("current") { () -> [String: Any]? in
      LiveCallCurrent.shared.dictionary
    }

    Function("consumePendingFallback") { () -> [String: Any]? in
      guard let pending = LiveCallPendingFallback.consume() else { return nil }
      return ["agent": pending.agent, "reason": pending.reason, "at": pending.at.timeIntervalSince1970 * 1000]
    }
  }
}
