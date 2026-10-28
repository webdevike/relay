// What a live call needs when no JavaScript is running (an App Intent from the lock screen):
//   - the paired hosts, handed over by JS `configure` and kept in this module's own Keychain item,
//     readable after the first unlock (expo-secure-store's items are only readable while unlocked);
//   - a pending fallback, left in UserDefaults when a call started by an intent could not go live,
//     for JS to pick up once the app is open and start the legacy call.

import Foundation
import Security

/// One paired Relay host, as JS hands it over. `url` is `ws://<authority>/relay`.
public struct LiveCallHost: Codable, Equatable {
  public let url: String
  public let deviceId: String
  public let deviceName: String
  public let secretHex: String
  public let name: String

  public init(url: String, deviceId: String, deviceName: String, secretHex: String, name: String) {
    self.url = url
    self.deviceId = deviceId
    self.deviceName = deviceName
    self.secretHex = secretHex
    self.name = name
  }
}

enum LiveCallHostStore {
  private static let service = "com.ike.relay.live-call"
  private static let account = "hosts"

  /// Replaces the saved hosts (preferred first). An empty list deletes the item.
  static func save(_ hosts: [LiveCallHost]) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(query as CFDictionary)
    guard !hosts.isEmpty, let data = try? JSONEncoder().encode(hosts) else { return }
    var item = query
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(item as CFDictionary, nil)
  }

  static func load() -> [LiveCallHost] {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return [] }
    return (try? JSONDecoder().decode([LiveCallHost].self, from: data)) ?? []
  }
}

/// A call that could not go live while no app was on screen: JS starts the legacy call for `agent`.
public struct LiveCallPendingFallback: Codable, Equatable {
  public let agent: String
  public let reason: String
  public let at: Date

  private static let key = "relay.liveCall.pendingFallback"
  /// Older than this, the moment has passed: opening Relay much later must not start a call.
  private static let maxAge: TimeInterval = 5 * 60

  static func store(agent: String, reason: String) {
    let value = LiveCallPendingFallback(agent: agent, reason: reason, at: Date())
    if let data = try? JSONEncoder().encode(value) {
      UserDefaults.standard.set(data, forKey: key)
    }
  }

  static func clear() {
    UserDefaults.standard.removeObject(forKey: key)
  }

  /// The pending fallback, removed as it is read; nil when there is none or it is stale.
  static func consume() -> LiveCallPendingFallback? {
    guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
    clear()
    guard let value = try? JSONDecoder().decode(LiveCallPendingFallback.self, from: data),
      Date().timeIntervalSince(value.at) < maxAge
    else { return nil }
    return value
  }
}
