import Carbon.HIToolbox
import Cocoa

/// System-wide hotkey through Carbon's RegisterEventHotKey. Needs no Accessibility permission
/// and consumes only this one key combination.
@MainActor
final class HotKey {
    private static var handlers: [UInt32: () -> Void] = [:]
    private static var eventHandlerInstalled = false
    private var ref: EventHotKeyRef?
    private let id: UInt32 = 1

    @discardableResult
    func register(keyCode: UInt32, modifiers: UInt32, action: @escaping () -> Void) -> Bool {
        HotKey.installEventHandler()
        HotKey.handlers[id] = action
        let hotKeyID = EventHotKeyID(signature: OSType(0x52_42_44_59), id: id) // "RBDY"
        let status = RegisterEventHotKey(keyCode, modifiers, hotKeyID, GetApplicationEventTarget(), 0, &ref)
        return status == noErr
    }

    private static func installEventHandler() {
        guard !eventHandlerInstalled else { return }
        eventHandlerInstalled = true
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var hotKeyID = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKeyID)
            let id = hotKeyID.id
            DispatchQueue.main.async {
                MainActor.assumeIsolated { HotKey.handlers[id]?() }
            }
            return noErr
        }, 1, &spec, nil, nil)
    }
}
