import type { Frame } from './line-framer'

/** An image attached to a prompt (omp RPC `images` field). `data` is base64 without the data: prefix. */
export type PromptImage = { type: 'image'; data: string; mimeType: string }

export type TransportExit = { code: number | null; signal: string | null; timedOut: boolean }

/**
 * What a chat view talks to (CHAT-08). `OmpStdioTransport` (main process) is the Phase 1
 * implementation. Phase 4 adds Claude Code, Relay-observed and Eregon transports behind this
 * same interface.
 *
 * omp protocol v2 (`rpc_chunk`) exists but is deliberately not negotiated in Phase 1 (decision 2):
 * the transport speaks v1 only and never sends a negotiate command.
 *
 * Frames delivered through `onFrame` include the synthetic `_stderr` ({ line }) and `_eof`
 * ({ code, signal }) frames.
 */
export interface ChatTransport {
  readonly kind: string
  /** `sessionFile: null` starts a new chat (no --resume); `args` are extra launch flags. */
  start(opts: { sessionFile: string | null; cwd: string; args?: readonly string[] }): Promise<void>
  /** Sends a prompt (omp treats a prompt sent mid-turn as a steer). */
  send(text: string, images?: readonly PromptImage[]): Promise<void>
  steer(text: string): Promise<void>
  abort(): Promise<void>
  /** Writes a raw command object as one JSON line; an `id` is filled in when missing. */
  write(command: Record<string, unknown>): Promise<void>
  /** Closes stdin and waits. Never signals the child (D-17). */
  close(opts?: { timeoutMs?: number }): Promise<TransportExit>
  onFrame(cb: (f: Frame) => void): () => void
}
