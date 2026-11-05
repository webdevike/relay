// Pasting an image into a React Native text input. UIKit offers Paste on a text view only for text, and
// RN's RCTUITextView / RCTUITextField drop an image, so a copied screenshot could never be pasted. While JS
// says an input is focused (`setActive`), this makes those two classes offer Paste when the clipboard holds an
// image and, when Paste is tapped, reads the image inside that user action (so iOS shows no paste prompt),
// encodes it as a JPEG and emits it as a `pasteImage` event instead of pasting. Text on the clipboard still
// pastes as usual, and with no active input nothing changes.

import ExpoModulesCore
import UIKit

public class PasteImageModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PasteImage")
    Events("pasteImage")

    OnCreate {
      DispatchQueue.main.async {
        PasteImageRelay.install()
        PasteImageRelay.onImage = { [weak self] data, width, height in
          self?.sendEvent("pasteImage", ["data": data, "width": width, "height": height])
        }
      }
    }

    OnDestroy {
      PasteImageRelay.onImage = nil
      PasteImageRelay.active = false
    }

    Function("setActive") { (active: Bool) in
      PasteImageRelay.active = active
    }
  }
}

enum PasteImageRelay {
  static var onImage: ((String, Int, Int) -> Void)?
  static var active = false
  private static var installed = false
  /// A pasted screenshot re-encoded at this JPEG quality: sharp enough to read text, small enough for one frame.
  private static let quality: CGFloat = 0.85

  static func install() {
    guard !installed else { return }
    installed = true
    for name in ["RCTUITextView", "RCTUITextField"] {
      guard let cls = NSClassFromString(name) else { continue }
      swap(cls, #selector(UIResponder.paste(_:)), #selector(UIResponder.relay_paste(_:)))
      swap(cls, #selector(UIResponder.canPerformAction(_:withSender:)), #selector(UIResponder.relay_canPerformAction(_:withSender:)))
    }
  }

  /// Exchanges `original` on `cls` with `replacement` (declared on UIResponder), giving `cls` its own copy first so no sibling class is touched.
  private static func swap(_ cls: AnyClass, _ original: Selector, _ replacement: Selector) {
    guard
      let replacementMethod = class_getInstanceMethod(UIResponder.self, replacement),
      let originalMethod = class_getInstanceMethod(cls, original)
    else { return }
    let added = class_addMethod(cls, replacement, method_getImplementation(replacementMethod), method_getTypeEncoding(replacementMethod))
    guard added, let ownReplacement = class_getInstanceMethod(cls, replacement) else { return }
    method_exchangeImplementations(originalMethod, ownReplacement)
  }

  /// True when Paste should take an image: an active input and an image on the clipboard with no text beside it.
  static var wantsImage: Bool {
    let board = UIPasteboard.general
    return active && board.hasImages && !board.hasStrings
  }

  static func deliverClipboardImage() {
    guard let image = UIPasteboard.general.image, let jpeg = image.jpegData(compressionQuality: quality) else { return }
    onImage?(jpeg.base64EncodedString(), Int(image.size.width * image.scale), Int(image.size.height * image.scale))
  }
}

extension UIResponder {
  /// After the exchange, `relay_paste` is the original `paste:`.
  @objc func relay_paste(_ sender: Any?) {
    if PasteImageRelay.wantsImage {
      PasteImageRelay.deliverClipboardImage()
      return
    }
    relay_paste(sender)
  }

  @objc func relay_canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    let editable = (self as? UITextView)?.isEditable ?? (self as? UITextField)?.isEnabled ?? false
    if action == #selector(UIResponder.paste(_:)), editable, PasteImageRelay.wantsImage { return true }
    return relay_canPerformAction(action, withSender: sender)
  }
}
