// The calibration log: every live run that had an estimate, what was predicted along the way and how
// long it really took, one JSON line each in `~/.config/relay/eta-calibration.jsonl`. It feeds the
// bias the estimator applies to runs like it (`biasFor`) and the accuracy `relay-host eta` reports.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { RUN_KINDS } from "./runs";
import type { CalibrationRecord } from "./accuracy";

/** The latest this many records are kept in memory (the file keeps everything). */
export const CALIBRATION_KEEP = 2000;

const Record = z.object({
  id: z.string(),
  title: z.string(),
  agent: z.enum(["chat", "task", "helper"]),
  kind: z.enum(RUN_KINDS),
  model: z.string().nullable(),
  thinking: z.string().nullable(),
  from: z.number(),
  actualMs: z.number().positive(),
  predictions: z.array(z.object({ elapsedMs: z.number(), totalMs: z.number(), lowMs: z.number(), highMs: z.number(), confident: z.boolean() })),
});

export class CalibrationLog {
  private list: CalibrationRecord[] = [];

  constructor(
    private readonly path: string,
    private readonly log: (line: string) => void = () => {},
  ) {
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (line === "") continue;
      try {
        const parsed = Record.safeParse(JSON.parse(line));
        if (parsed.success) this.list.push(parsed.data);
      } catch {
        // A line cut by a crash mid-write.
      }
    }
    this.list = this.list.slice(-CALIBRATION_KEEP);
  }

  records(): readonly CalibrationRecord[] {
    return this.list;
  }

  add(record: CalibrationRecord): void {
    this.list.push(record);
    if (this.list.length > CALIBRATION_KEEP) this.list.shift();
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    } catch (error) {
      this.log(`eta: could not log calibration: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
