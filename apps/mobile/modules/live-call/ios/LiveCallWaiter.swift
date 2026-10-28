import Foundation

/// Why a live call stopped before or while going live.
enum LiveCallFailure: Error {
  /// GPT-Live could not be reached (host unreachable, no key on the host, OpenAI refused, timeouts):
  /// the legacy call can still work.
  case fallback(String)
  /// Calling cannot work at all (microphone denied): say so instead of falling back.
  case failed(String)
  /// Hung up (or replaced by another call) while it was starting.
  case cancelled

  var message: String {
    switch self {
    case .fallback(let reason), .failed(let reason): return reason
    case .cancelled: return "Hung up"
    }
  }
}

/// A value that arrives once, awaited with a deadline. Main actor only.
@MainActor
final class LiveCallWaiter<Value> {
  private var continuation: CheckedContinuation<Value, Error>?
  private var outcome: Result<Value, Error>?

  var isSettled: Bool { outcome != nil }

  func resolve(_ value: Value) {
    settle(.success(value))
  }

  func fail(_ error: Error) {
    settle(.failure(error))
  }

  /// The value, or `timeoutError` once `seconds` pass without one.
  func wait(seconds: Double, timeoutError: Error) async throws -> Value {
    if let outcome { return try outcome.get() }
    let timer = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
      if !Task.isCancelled { self?.fail(timeoutError) }
    }
    defer { timer.cancel() }
    return try await withCheckedThrowingContinuation { continuation in
      if let outcome {
        continuation.resume(with: outcome)
      } else {
        self.continuation = continuation
      }
    }
  }

  private func settle(_ result: Result<Value, Error>) {
    guard outcome == nil else { return }
    outcome = result
    continuation?.resume(with: result)
    continuation = nil
  }
}
