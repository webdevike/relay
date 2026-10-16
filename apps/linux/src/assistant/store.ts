// Where the host remembers Eva's thread between restarts: `$XDG_CONFIG_HOME/relay/assistant.json`
// (dir 0700, file 0600, written atomically like devices.json). It holds the omp session file the
// live thread lives in, and `history`: the session files of earlier contexts (the nightly rollover
// moves the finished one there), which the host reads back so the thread on the phone stays whole.
// The transcripts themselves are omp's; this is only the pointer that lets the host resume the
// live one (`omp --resume <file>`) and replay the old ones. Older files without `history` read as [].

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const AssistantRecord = z.object({
  /** Absolute path of the live omp session file (`~/.omp/agent/sessions/<cwd>/<stamp>_<id>.jsonl`); absent between a rollover and the next turn. */
  sessionFile: z.string().min(1).optional(),
  /** Session files of earlier contexts, oldest first. */
  history: z.array(z.string().min(1)).default([]),
});
export type AssistantRecord = z.infer<typeof AssistantRecord>;

export interface AssistantStore {
  /** The remembered thread; null before Eva ever ran or when the file is unreadable. */
  load(): AssistantRecord | null;
  save(record: AssistantRecord): void;
}

export function defaultAssistantPath(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "relay", "assistant.json");
}

export class FileAssistantStore implements AssistantStore {
  constructor(private readonly path: string = defaultAssistantPath()) {}

  load(): AssistantRecord | null {
    if (!existsSync(this.path)) return null;
    try {
      const parsed = AssistantRecord.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  save(record: AssistantRecord): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
