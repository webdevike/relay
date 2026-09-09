import Foundation
import Security

public struct PairedDevice: Equatable, Sendable {
    public let id: String
    public let name: String
    public let pairedAt: Date

    public init(id: String, name: String, pairedAt: Date) {
        self.id = id
        self.name = name
        self.pairedAt = pairedAt
    }
}

/// Where paired-device secrets live. `KeychainDeviceStore` is the shipped implementation; tests
/// use an in-memory fake.
public protocol DeviceStore: AnyObject {
    func secret(for deviceId: String) -> Data?
    func save(secret: Data, deviceId: String, deviceName: String)
    func forget(deviceId: String)
    func pairedDevices() -> [PairedDevice]
}

/// One generic-password Keychain item per paired device: service `com.ike.relay.device`, account
/// is the device id, value is a small JSON envelope (secret + name + pairedAt). Not iCloud-synced:
/// pairing is per-Mac-per-phone and re-pairing is cheap.
public final class KeychainDeviceStore: DeviceStore {
    private static let service = "com.ike.relay.device"

    private struct Record: Codable {
        let secret: Data
        let name: String
        let pairedAt: Date
    }

    public init() {}

    public func secret(for deviceId: String) -> Data? {
        record(for: deviceId)?.secret
    }

    public func save(secret: Data, deviceId: String, deviceName: String) {
        let record = Record(secret: secret, name: deviceName, pairedAt: Date())
        guard let data = try? JSONEncoder().encode(record) else { return }
        let query = Self.baseQuery(deviceId: deviceId)
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrSynchronizable as String] = false
        SecItemAdd(add as CFDictionary, nil)
    }

    public func forget(deviceId: String) {
        SecItemDelete(Self.baseQuery(deviceId: deviceId) as CFDictionary)
    }

    public func pairedDevices() -> [PairedDevice] {
        var query = Self.baseQuery(deviceId: nil)
        query[kSecReturnAttributes as String] = true
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitAll
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let items = result as? [[String: Any]] else { return [] }
        return items.compactMap { item in
            guard let deviceId = item[kSecAttrAccount as String] as? String,
                  let data = item[kSecValueData as String] as? Data,
                  let record = try? JSONDecoder().decode(Record.self, from: data)
            else { return nil }
            return PairedDevice(id: deviceId, name: record.name, pairedAt: record.pairedAt)
        }
    }

    private func record(for deviceId: String) -> Record? {
        var query = Self.baseQuery(deviceId: deviceId)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(Record.self, from: data)
    }

    private static func baseQuery(deviceId: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        if let deviceId {
            query[kSecAttrAccount as String] = deviceId
        }
        return query
    }
}
