// Where the host remembers Eva's thread between restarts: `$XDG_CONFIG_HOME/relay/assistant.json`
// (dir 0700, file 0600, written atomically like devices.json) holding the omp session file the
// thread lives in. The transcript itself is omp's; this is only the pointer that lets the host
// resume it (`omp --resume <file>`) instead of starting Eva over.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const AssistantRecord = z.object({
  /** Absolute path of the omp session file (`~/.omp/agent/sessions/<cwd>/<stamp>_<id>.jsonl`). */
  sessionFile: z.string().min(1),
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
