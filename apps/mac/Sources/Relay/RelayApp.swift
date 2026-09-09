import SwiftUI
import RelayCore

@main
struct RelayApp: App {
    var body: some Scene {
        MenuBarExtra("Relay", systemImage: "iphone.radiowaves.left.and.right") {
            Text("Relay \(relayVersion)")
        }
    }
}
