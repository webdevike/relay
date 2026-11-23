// A scripted Deepgram socket for tests: after it opens, the server applies the settings, stays
// silent or errors; frames can then be emitted by hand.
import type { AgentSocket } from "../src/call/deepgram";

/** What the server does after the socket opens: apply the settings, stay silent, or fail. */
export type Server = "applies" | "silent" | "errors";

export class FakeSocket implements AgentSocket {
  binaryType: AgentSocket["binaryType"] = "blob";
  onopen: (() => void) | null = null;
  onmessage: AgentSocket["onmessage"] = null;
  onerror: (() => void) | null = null;
  onclose: AgentSocket["onclose"] = null;
  readonly sent: (string | Uint8Array)[] = [];
  closed = 0;
  constructor(private readonly server: Server = "applies") {
    setTimeout(() => {
      this.onopen?.();
    }, 0);
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data);
    if (typeof data === "string" && data.includes('"Settings"')) {
      if (this.server === "applies") setTimeout(() => { this.emit({ type: "SettingsApplied" }); }, 0);
      if (this.server === "errors") setTimeout(() => { this.emit({ type: "Error", code: "INVALID_SETTINGS", description: "bad" }); }, 0);
    }
  }
  close(): void {
    this.closed += 1;
  }
  emit(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  json(): { type: string }[] {
    return this.sent.flatMap((frame) => (typeof frame === "string" ? [JSON.parse(frame) as { type: string }] : []));
  }
}
