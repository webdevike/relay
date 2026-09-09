@testable import RelayCore
import RelayProtocol
import XCTest

final class KeyboardInjectorTests: XCTestCase {
    func testInsertChunksLongTextAndSendsReturnForNewline() throws {
        let poster = RecordingEventPoster()
        let accessibility = FakeAccessibility(isTrusted: true)
        let injector = KeyboardInjector(poster: poster, accessibility: accessibility)

        // 45 chars total: 5 before the newline (1 chunk), 39 after (two chunks of 20 + 19).
        let before = String(repeating: "a", count: 5)
        let after = String(repeating: "b", count: 39)
        let text = before + "\n" + after
        XCTAssertEqual(text.count, 45)

        try injector.insert(text)

        XCTAssertEqual(poster.calls.count, 4)
        guard case let .typeUnicode(chunk1) = poster.calls[0] else { return XCTFail("expected unicode chunk") }
        XCTAssertEqual(chunk1.count, 5)
        guard case .pressKey(36) = poster.calls[1] else { return XCTFail("expected return keypress") }
        guard case let .typeUnicode(chunk2) = poster.calls[2] else { return XCTFail("expected unicode chunk") }
        XCTAssertEqual(chunk2.count, 20)
        guard case let .typeUnicode(chunk3) = poster.calls[3] else { return XCTFail("expected unicode chunk") }
        XCTAssertEqual(chunk3.count, 19)
    }

    func testInsertThrowsAndPostsNothingWhenUntrusted() {
        let poster = RecordingEventPoster()
        let accessibility = FakeAccessibility(isTrusted: false)
        let injector = KeyboardInjector(poster: poster, accessibility: accessibility)

        XCTAssertThrowsError(try injector.insert("hello")) { error in
            guard let ackError = error as? AckError else { return XCTFail("expected AckError") }
            XCTAssertEqual(ackError.code, .accessibilityDenied)
        }
        XCTAssertTrue(poster.calls.isEmpty)
    }

    func testPressThrowsAndPostsNothingWhenUntrusted() {
        let poster = RecordingEventPoster()
        let accessibility = FakeAccessibility(isTrusted: false)
        let injector = KeyboardInjector(poster: poster, accessibility: accessibility)

        XCTAssertThrowsError(try injector.press(.return)) { error in
            guard let ackError = error as? AckError else { return XCTFail("expected AckError") }
            XCTAssertEqual(ackError.code, .accessibilityDenied)
        }
        XCTAssertTrue(poster.calls.isEmpty)
    }

    func testPressMapsEachKeyToItsVirtualKeyCode() throws {
        let poster = RecordingEventPoster()
        let accessibility = FakeAccessibility(isTrusted: true)
        let injector = KeyboardInjector(poster: poster, accessibility: accessibility)

        try injector.press(.return)
        try injector.press(.escape)
        try injector.press(.backspace)
        try injector.press(.tab)

        XCTAssertEqual(poster.calls, [.pressKey(36), .pressKey(53), .pressKey(51), .pressKey(48)])
    }
}
