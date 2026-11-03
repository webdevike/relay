import Carbon.HIToolbox
import Cocoa
import Foundation

/// Push-to-talk plus spoken answers, with barge-in: starting to talk, Esc, "stop" or a new ask silences
/// her at once; a click (the user doing what she said) never does. The app owns one of these and
/// forwards the callbacks into the bubble and overlay.
///
///     beginListening()   key down: silences Buddy, starts the mic, partials stream to onPartial
///     endListening()     key up: stops the mic, onFinal(text) fires with the transcript
///     cancelListening()  dismissed: drop the turn, no onFinal
///     speak(text)        say the caption aloud (replaces anything still playing)
///     stopSpeaking()     silence now (Esc, "stop", a new question)
@MainActor
final class VoiceController {
    var onListening: ((Bool) -> Void)?
    var onPartial: ((String) -> Void)?
    var onLevel: ((Float) -> Void)?
    /// Final transcript of a turn, never empty.
    var onFinal: ((String) -> Void)?
    /// Nothing was heard (too short or silent).
    var onNoSpeech: (() -> Void)?
    var onError: ((Error) -> Void)?
    var onSpeaking: ((Bool) -> Void)?

    let output: VoiceOutput
    private let makeInput: () -> VoiceInput
    private var input: VoiceInput?
    private var startTask: Task<Void, Error>?
    private var speakTask: Task<Void, Never>?
    private var turn = 0
    private var speakTurn = 0

    init(output: VoiceOutput = OpenAISpeech(), makeInput: @escaping () -> VoiceInput = { MicVoiceInput() }) {
        self.output = output
        self.makeInput = makeInput
    }

    var isListening: Bool { input != nil }
    var isSpeaking: Bool { output.isSpeaking }

    func beginListening() {
        guard input == nil else { return }
        stopSpeaking()
        turn += 1
        let mine = turn
        let source = makeInput()
        source.onPartial = { [weak self] text in
            MainActor.assumeIsolated { if self?.turn == mine { self?.onPartial?(text) } }
        }
        source.onLevel = { [weak self] level in
            MainActor.assumeIsolated { if self?.turn == mine { self?.onLevel?(level) } }
        }
        input = source
        onListening?(true)
        startTask = Task { [weak self] in
            do { try await source.start() } catch {
                if let self, self.turn == mine {
                    self.input = nil
                    self.onListening?(false)
                    self.onError?(error)
                }
                throw error
            }
        }
    }

    func endListening() {
        guard let source = input else { return }
        input = nil
        onListening?(false)
        let mine = turn
        let starting = startTask
        Task { [weak self] in
            // Permission prompt or connection may still be pending; start() reports its own failure.
            do { try await starting?.value } catch { return }
            do {
                let text = try await source.stop()
                guard let self, self.turn == mine else { return }
                if text.isEmpty { self.onNoSpeech?() } else { self.onFinal?(text) }
            } catch {
                guard let self, self.turn == mine else { return }
                self.onError?(error)
            }
        }
    }

    func cancelListening() {
        turn += 1
        input?.cancel()
        input = nil
        onListening?(false)
    }

    /// `voice`: the answering assistant's liveVoice, the same voice name Relay's live calls use.
    func speak(_ text: String, voice: String) {
        speakTask?.cancel()
        // Silence the line still playing now, before the new one starts: the old speak() then sees it is no
        // longer current and leaves the new line's audio engine alone.
        output.stop()
        speakTurn += 1
        let mine = speakTurn
        onSpeaking?(true)
        speakTask = Task { [weak self] in
            guard let self else { return }
            do { try await self.output.speak(text, voice: voice) } catch {
                if self.speakTurn == mine { self.onError?(error) }
            }
            if self.speakTurn == mine { self.onSpeaking?(false) }
        }
    }

    func stopSpeaking() {
        speakTurn += 1
        speakTask?.cancel()
        output.stop()
        onSpeaking?(false)
    }
}

/// System-wide hotkey that tells a tap from a hold (Carbon, no Accessibility permission needed).
/// Tap = onTap (open the typed bubble); hold longer than `holdThreshold` = push to talk.
/// Drop-in replacement for HotKey for Control+Option+Space: only one of the two may own the combo.
@MainActor
final class HoldHotKey {
    var onTap: (() -> Void)?
    var onHoldStart: (() -> Void)?
    var onHoldEnd: (() -> Void)?
    var holdThreshold: TimeInterval = 0.30

    private static var current: HoldHotKey?
    private static var installed = false
    private var ref: EventHotKeyRef?
    private var isDown = false
    private var holding = false
    private var timer: DispatchWorkItem?

    @discardableResult
    func register(keyCode: UInt32, modifiers: UInt32) -> Bool {
        HoldHotKey.install()
        HoldHotKey.current = self
        let hotKeyID = EventHotKeyID(signature: OSType(0x52_42_56_43), id: 7)   // "RBVC"
        return RegisterEventHotKey(keyCode, modifiers, hotKeyID, GetApplicationEventTarget(), 0, &ref) == noErr
    }

    func unregister() {
        if let ref { UnregisterEventHotKey(ref) }
        ref = nil
    }

    fileprivate func pressed() {
        guard !isDown else { return }
        isDown = true
        holding = false
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.isDown else { return }
            self.holding = true
            self.onHoldStart?()
        }
        timer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + holdThreshold, execute: item)
    }

    fileprivate func released() {
        guard isDown else { return }
        isDown = false
        timer?.cancel()
        if holding { holding = false; onHoldEnd?() } else { onTap?() }
    }

    private static func install() {
        guard !installed else { return }
        installed = true
        var specs = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var hotKeyID = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKeyID)
            guard hotKeyID.signature == OSType(0x52_42_56_43) else { return OSStatus(eventNotHandledErr) }
            let isPress = GetEventKind(event) == UInt32(kEventHotKeyPressed)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    if isPress { HoldHotKey.current?.pressed() } else { HoldHotKey.current?.released() }
                }
            }
            return noErr
        }, 2, &specs, nil, nil)
    }
}
