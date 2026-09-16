// Pasting a phone image into the focused app: the bytes go on the Wayland clipboard through
// `wl-copy` (which stays resident to serve the selection), then Ctrl+V is tapped through uinput.
// The clipboard watcher would otherwise record the new selection as a host drop and push it back
// to the phone it came from, so it is told what is coming first.

import type { AgentImage } from "@relay/protocol";
import { AckFailure, type ImagePasting } from "../seams";
import type { EventPoster } from "./poster";

// linux/input-event-codes.h
const KEY_LEFTCTRL = 29;
const KEY_V = 47;

/** Puts `bytes` on the clipboard as `mimeType`; rejects when the copy tool fails. */
export type ClipboardCopy = (mimeType: string, bytes: Uint8Array) => Promise<void>;

export interface ClipboardPasterDeps {
  readonly poster: EventPoster;
  readonly copy: ClipboardCopy;
  /** Tells the clipboard watcher to skip the selection about to appear; null without a watcher. */
  readonly expect: ((mimeType: string, bytes: Uint8Array) => void) | null;
}

export class ClipboardPaster implements ImagePasting {
  constructor(private readonly deps: ClipboardPasterDeps) {}

  async paste(image: AgentImage): Promise<void> {
    const bytes = new Uint8Array(Buffer.from(image.data, "base64"));
    if (bytes.length === 0)
      throw new AckFailure({ code: "invalid_command", message: "empty image" });
    this.deps.expect?.(image.mimeType, bytes);
    try {
      await this.deps.copy(image.mimeType, bytes);
    } catch (error) {
      throw new AckFailure({
        code: "internal",
        message: `clipboard: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    this.deps.poster.tapKey(KEY_V, [KEY_LEFTCTRL]);
  }
}

/**
 * `wl-copy --type <mime>` with the bytes on stdin. It forks a child that keeps serving the
 * selection and inherits the parent's descriptors, so stderr is not piped: reading it would block
 * until the selection is replaced. A non-zero exit is all the error reporting there is.
 */
export async function systemCopy(mimeType: string, bytes: Uint8Array): Promise<void> {
  const child = Bun.spawn(["wl-copy", "--type", mimeType], {
    stdin: bytes,
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`wl-copy exited ${code}`);
}
