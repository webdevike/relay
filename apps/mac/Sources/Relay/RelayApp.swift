import RelayCore
import SwiftUI

@main
struct RelayApp: App {
    @StateObject private var model: AppModel

    init() {
        let model = AppModel()
        _model = StateObject(wrappedValue: model)
        model.start()
    }

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model)
        } label: {
            MenuBarLabel(state: model.state)
        }
        .menuBarExtraStyle(.window)
    }
}

private struct MenuBarLabel: View {
    let state: RelayServer.ServerState

    var body: some View {
        Image(systemName: "iphone.radiowaves.left.and.right")
            .symbolVariant(isActive ? .none : .slash)
    }

    private var isActive: Bool {
        switch state {
        case .starting, .listening: return true
        case .stopped, .failed: return false
        }
    }
}
