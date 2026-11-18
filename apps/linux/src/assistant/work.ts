// The work behind an assistant thread's turns (`assistant.work.req`, protocol `turn-work.ts`), read from the
// thread's omp transcripts on demand. Nothing of it goes into `assistant.snapshot`: a phone asks for one turn
// when Isaac opens its sheet, again while that turn runs, and for one step's full text when he opens the step.
// A transcript is parsed once and then only its appended bytes (the live one grows a line per message), so a
// running turn's refreshes stay cheap.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { workMessageOf, type WorkMessage } from "@relay/protocol";

/** Transcripts kept parsed: the live one and the earlier context Isaac last looked into. */
const MAX_FILES = 3;
const NEWLINE = 0x0a;

interface Parsed {
  /** Bytes read so far (up to the last whole line). */
  size: number;
  messages: WorkMessage[];
}

/** The turn messages of one session-file line, or null for any other line and a line that does not parse. */
function lineMessage(line: string): WorkMessage | null {
  if (line.trim() === "") return null;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof entry !== "object" || entry === null) return null;
  const { type, message } = entry as { type?: unknown; message?: unknown };
  return type === "message" ? workMessageOf(message) : null;
}

/** Reads transcripts into the fold's messages, each file once and then only what was appended to it. */
export class WorkReader {
  private readonly files = new Map<string, Parsed>();

  /** The turn messages of transcript `file`, in order; null when it cannot be read. */
  messages(file: string): readonly WorkMessage[] | null {
    let fd: number;
    try {
      fd = openSync(file, "r");
    } catch {
      this.files.delete(file);
      return null;
    }
    try {
      const size = fstatSync(fd).size;
      let parsed = this.files.get(file);
      // A file that shrank was rewritten: read it again from the start.
      if (parsed === undefined || size < parsed.size) parsed = { size: 0, messages: [] };
      if (size > parsed.size) {
        const bytes = Buffer.alloc(size - parsed.size);
        const read = readSync(fd, bytes, 0, bytes.length, parsed.size);
        const whole = bytes.subarray(0, read).lastIndexOf(NEWLINE) + 1;
        for (const line of bytes.subarray(0, whole).toString("utf8").split("\n")) {
          const message = lineMessage(line);
          if (message !== null) parsed.messages.push(message);
        }
        parsed.size += whole;
      }
      this.files.delete(file);
      this.files.set(file, parsed);
      for (const old of this.files.keys()) {
        if (this.files.size <= MAX_FILES) break;
        this.files.delete(old);
      }
      return parsed.messages;
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * Which of a thread's transcripts holds phone row `row`: an earlier context's rows are named
 * `<file stem>-<n>` (`AssistantService.transcript`), every other row is the live session's (`live`).
 */
export function transcriptOfRow(
  row: string | undefined,
  earlier: readonly string[],
  live: string | null,
): string | null {
  if (row !== undefined)
    for (const file of earlier) if (row.startsWith(`${basename(file, ".jsonl")}-`)) return file;
  return live;
}
