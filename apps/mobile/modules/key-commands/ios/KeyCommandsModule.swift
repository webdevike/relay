// Hardware-keyboard shortcuts. React Native exposes no key events outside a focused text input, so
// this adds a UIKeyCommand (Cmd+[, titled "Back" in the iPad Cmd-hold overlay) to the window's
// root view controller by wrapping its `keyCommands` getter, and forwards presses to JS as a
// `back` event. The command lives at the end of the responder chain, so a focused text input
// handles its own keys first and typing is never intercepted. Cmd+Left is deliberately not bound:
// text fields use it to jump to the start of the line.

import ExpoModulesCore
import UIKit

public class KeyCommandsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KeyCommands")
    Events("back")

    OnCreate {
      DispatchQueue.main.async {
        KeyCommandsRelay.install()
        KeyCommandsRelay.onBack = { [weak self] in
          self?.sendEvent("back", [:])
        }
      }
    }

    OnDestroy {
      KeyCommandsRelay.onBack = nil
    }
  }
}

enum KeyCommandsRelay {
  static var onBack: (() -> Void)?
  private static var installed = false

  static func install() {
    guard !installed else { return }
    installed = true
    let original = #selector(getter: UIViewController.keyCommands)
    let replacement = #selector(UIViewController.relay_keyCommands)
    guard
      let originalMethod = class_getInstanceMethod(UIViewController.self, original),
      let replacementMethod = class_getInstanceMethod(UIViewController.self, replacement)
    else { return }
    method_exchangeImplementations(originalMethod, replacementMethod)
  }
}

extension UIViewController {
  @objc func relay_keyCommands() -> [UIKeyCommand]? {
    // After the exchange this calls the original getter.
    var commands = relay_keyCommands() ?? []
    if view.window?.rootViewController === self {
      let back = UIKeyCommand(
        title: "Back", action: #selector(relay_back), input: "[", modifierFlags: .command)
      back.discoverabilityTitle = "Back"
      commands.append(back)
    }
    return commands
  }

  @objc func relay_back() {
    KeyCommandsRelay.onBack?()
  }
}
