// Relay's recordings on the host: `$XDG_CONFIG_HOME/relay/meetings/<id>/` holds `meta.json`, the
// two tracks as raw 16 kHz mono s16 (`app.pcm`, `mic.pcm`, written at their sample offsets as the
// ingest socket delivers them), the live transcript's lines (`lines.jsonl`) and, after the call,
// the WAVs the worker reads. Audio is kept RETENTION_DAYS, then the whole folder goes; the notes
// live on in the protocols folder.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  LiveLine,
  MeetingHealth,
  MeetingStage,
  MEETING_SAMPLE_RATE,
  type MeetingRecording,
} from "@relay/protocol";
import { z } from "zod";
import { readJson, writeJson } from "../reviews/exec";
import { PlatformSampleSchema, type PlatformSample } from "./speakers";

export const RETENTION_DAYS = 30;
export const TRACKS = ["app", "mic"] as const;
export type TrackName = (typeof TRACKS)[number];

export function defaultMeetingsDir(): string {
  return join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "relay", "meetings");
}

export const RecordingMeta = z.object({
  id: z.string(),
  app: z.string(),
  title: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  device: z.string(),
  deviceId: z.string(),
  stage: MeetingStage,
  health: MeetingHealth,
  healthDetail: z.string(),
  error: z.string().nullable(),
  shadow: z.boolean(),
  stem: z.string().nullable(),
  /** Samples per track the Mac said the recording has (from `meeting.end`); null while recording. */
  total: z.object({ app: z.number(), mic: z.number() }).nullable(),
  micLeadMs: z.number().nullable(),
  globalTap: z.boolean(),
  /** The calendar or Slack context found for it (mt-autoname's `Meeting`), once looked up. */
  context: z.object({ annotation: z.string(), remoteName: z.string().optional() }).nullable(),
  /** Remote labels Isaac named by hand (`R_S2` -> name). */
  names: z.record(z.string(), z.string()),
  /** The assistant whose chat the meeting is in (route.ts); recordings from before routing have none. */
  assistant: z.string().nullable().default(null),
  /** Isaac moved it there himself, so the calendar lookup leaves it. */
  routedByIsaac: z.boolean().default(false),
});
export type RecordingMeta = z.infer<typeof RecordingMeta>;

export function publicRecording(m: RecordingMeta, seconds: number): MeetingRecording {
  return {
    id: m.id,
    app: m.app,
    title: m.title,
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    device: m.device,
    stage: m.stage,
    health: m.health,
    healthDetail: m.healthDetail,
    error: m.error,
    shadow: m.shadow,
    stem: m.stem,
    seconds,
    assistant: m.assistant,
    routedByIsaac: m.routedByIsaac,
  };
}

/** Samples on disk per track (a file's size / 2). */
export function samplesOf(dir: string, track: TrackName): number {
  try {
    return Math.floor(statSync(join(dir, `${track}.pcm`)).size / 2);
  } catch {
    return 0;
  }
}

export class RecordingStore {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  dir(id: string): string {
    return join(this.root, id);
  }

  load(id: string): RecordingMeta | null {
    const r = RecordingMeta.safeParse(readJson(join(this.dir(id), "meta.json"), null));
    return r.success ? r.data : null;
  }

  save(meta: RecordingMeta): void {
    mkdirSync(this.dir(meta.id), { recursive: true, mode: 0o700 });
    writeJson(join(this.dir(meta.id), "meta.json"), meta);
  }

  /** Every readable recording, newest first. */
  all(): RecordingMeta[] {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return [];
    }
    return names
      .map((n) => this.load(n))
      .filter((m): m is RecordingMeta => m !== null)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Writes `pcm` (s16 LE) of `track` at sample `at`. */
  writePcm(id: string, track: TrackName, at: number, pcm: Uint8Array): void {
    const fd = openSync(
      join(this.dir(id), `${track}.pcm`),
      existsSync(join(this.dir(id), `${track}.pcm`)) ? "r+" : "w",
    );
    try {
      writeSync(fd, pcm, 0, pcm.byteLength, at * 2);
    } finally {
      closeSync(fd);
    }
  }

  appendLines(id: string, lines: readonly LiveLine[]): void {
    if (lines.length === 0) return;
    appendFileSync(
      join(this.dir(id), "lines.jsonl"),
      lines.map((l) => `${JSON.stringify(l)}\n`).join(""),
      { mode: 0o600 },
    );
  }

  /** The final lines kept so far (the last copy of each id wins). */
  lines(id: string): LiveLine[] {
    let text: string;
    try {
      text = readFileSync(join(this.dir(id), "lines.jsonl"), "utf8");
    } catch {
      return [];
    }
    const byId = new Map<string, LiveLine>();
    for (const row of text.split("\n")) {
      if (row.trim() === "") continue;
      try {
        const r = LiveLine.safeParse(JSON.parse(row));
        if (r.success) byId.set(r.data.id, r.data);
      } catch {
        // a torn last row after a crash
      }
    }
    return [...byId.values()].sort((a, b) => a.startMs - b.startMs);
  }

  /**
   * Appends the Mac's window samples (`speakers.jsonl`), one row per line it sent: a sample that
   * failed validation is kept as `null`, so the row count stays the Mac's line count (its acks).
   */
  appendSpeakers(id: string, rows: readonly (PlatformSample | null)[]): void {
    if (rows.length === 0) return;
    appendFileSync(
      join(this.dir(id), "speakers.jsonl"),
      rows.map((s) => `${JSON.stringify(s)}\n`).join(""),
      { mode: 0o600 },
    );
  }

  /** The window samples kept so far, in order, and how many rows the Mac has sent. */
  speakers(id: string): { samples: PlatformSample[]; rows: number } {
    let text: string;
    try {
      text = readFileSync(join(this.dir(id), "speakers.jsonl"), "utf8");
    } catch {
      return { samples: [], rows: 0 };
    }
    const samples: PlatformSample[] = [];
    let rows = 0;
    for (const row of text.split("\n")) {
      if (row.trim() === "") continue;
      rows += 1;
      try {
        const r = PlatformSampleSchema.safeParse(JSON.parse(row));
        if (r.success) samples.push(r.data);
      } catch {
        // a torn last row after a crash
      }
    }
    return { samples, rows };
  }

  /** `<track>.wav` next to the raw track (a 44-byte header plus the samples, padded to `samples`). */
  wav(id: string, track: TrackName, samples: number): string {
    const dir = this.dir(id);
    const out = join(dir, `${track}.wav`);
    let pcm: Buffer;
    try {
      pcm = readFileSync(join(dir, `${track}.pcm`));
    } catch {
      pcm = Buffer.alloc(0);
    }
    const body =
      pcm.length >= samples * 2
        ? pcm
        : Buffer.concat([pcm, Buffer.alloc(samples * 2 - pcm.length)]);
    const fd = openSync(out, "w", 0o600);
    try {
      writeSync(fd, wavHeader(body.length));
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    return out;
  }

  remove(id: string): void {
    rmSync(this.dir(id), { recursive: true, force: true });
  }

  /** Deletes recordings that ended more than RETENTION_DAYS ago; answers their ids. */
  sweep(now: number): string[] {
    const cutoff = now - RETENTION_DAYS * 86_400_000;
    const gone: string[] = [];
    for (const m of this.all()) {
      if ((m.endedAt ?? m.startedAt) < cutoff) {
        this.remove(m.id);
        gone.push(m.id);
      }
    }
    return gone;
  }
}

export function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(MEETING_SAMPLE_RATE, 24);
  h.writeUInt32LE(MEETING_SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}
