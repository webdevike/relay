// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "Relay",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Relay", targets: ["Relay"]),
        .library(name: "RelayCore", targets: ["RelayCore"]),
        .library(name: "RelayProtocol", targets: ["RelayProtocol"]),
    ],
    targets: [
        // Wire types. Mirrors packages/protocol/src/index.ts; conformance-tested against its fixtures.
        .target(name: "RelayProtocol"),
        // Everything that is not UI: server, sessions, pairing, input generation, agent providers.
        .target(name: "RelayCore", dependencies: ["RelayProtocol"], exclude: ["Transport/README.md", "Input/README.md"]),
        // SwiftUI menu-bar app. Thin: owns windows and wires RelayCore together.
        .executableTarget(name: "Relay", dependencies: ["RelayCore", "RelayProtocol"]),
        .testTarget(name: "RelayProtocolTests", dependencies: ["RelayProtocol"]),
        .testTarget(name: "RelayCoreTests", dependencies: ["RelayCore", "RelayProtocol"]),
    ]
)
