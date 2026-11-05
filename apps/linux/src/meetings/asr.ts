// The relay-asr worker (apps/linux/asr/relay_asr.py): one Python process per host in its own venv,
// started on first use and kept while there is work (it drops its model after 10 idle minutes on
// its own). Live sessions stream audio in and lines out; jobs (AEC over a whole call, an offline
// transcription, diarization) answer once. A crash fails the jobs in flight and loses the live
// sessions; `onRestart` lets the service open them again where their audio stands.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export function asrHome(): string {
  return (
    process.env["RELAY_ASR_HOME"] ??
    join(process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"), "relay", "asr")
  );
}

/** The venv's python (`apps/linux/asr/setup.sh` makes it), or `$RELAY_ASR_PYTHON`. */
export function asrPython(): string {
  return process.env["RELAY_ASR_PYTHON"] ?? join(asrHome(), ".venv", "bin", "python");
}

/** Diarization models (pyannote segmentation 3.0, TitaNet-small) that setup.sh downloads. */
export function asrModels(): string {
  return process.env["RELAY_ASR_MODELS"] ?? join(asrHome(), "models");
}

/**
 * relay_asr.py: `Resources/asr` in Relay Host.app (build.sh copies it there; a compiled host's
 * `import.meta.dirname` is inside its virtual filesystem), `apps/linux/asr` in a checkout.
 */
const BUNDLED_ASR_SCRIPT = join(
  dirname(process.execPath),
  "..",
  "Resources",
  "asr",
  "relay_asr.py",
);
export const ASR_SCRIPT = existsSync(BUNDLED_ASR_SCRIPT)
  ? BUNDLED_ASR_SCRIPT
  : join(import.meta.dirname, "..", "..", "asr", "relay_asr.py");

const WorkerLine = z.object({
  ev: z.literal("line"),
  meeting: z.string(),
  track: z.enum(["app", "mic"]),
  id: z.string(),
  start: z.number(),
  end: z.number(),
  text: z.string(),
  final: z.boolean(),
  /** App finals: [start, end, word] in samples. */
  words: z.array(z.tuple([z.number(), z.number(), z.string()])).optional(),
});
export type WorkerLine = z.infer<typeof WorkerLine>;

const WorkerTurns = z.object({
  ev: z.literal("turns"),
  meeting: z.string(),
  /** The app final these turns are inside. */
  id: z.string(),
  turns: z.array(z.object({ start: z.number(), end: z.number(), speaker: z.number().int() })),
  /** Voice labels a known voice print names. */
  names: z.record(z.string(), z.string()),
});
export type WorkerTurns = z.infer<typeof WorkerTurns>;

export interface Segment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}
export interface Turn {
  readonly start: number;
  readonly end: number;
  readonly speaker: number;
}

/** What the service needs from the worker (a fake in tests). */
export interface Asr {
  /** `human`: the mic's owner, never the name of a remote voice. */
  open(meeting: string, app: number, mic: number, human: string): void;
  audio(meeting: string, track: "app" | "mic", at: number, pcm: Uint8Array): void;
  /** Flushes the session's open utterances as finals; resolves once they are out. */
  close(meeting: string): Promise<void>;
  /** The meeting app named voice `label`: Relay's voice prints learn it (before `close`). */
  learn(meeting: string, label: number, name: string): void;
  aec(app: string, mic: string, out: string): Promise<void>;
  transcribe(wav: string): Promise<Segment[]>;
  diarize(wav: string): Promise<Turn[]>;
  stop(): void;
}

export interface AsrWorkerDeps {
  readonly onLine: (line: WorkerLine) => void;
  readonly onTurns: (turns: WorkerTurns) => void;
  /** The worker came back after a crash: live sessions must be opened again. */
  readonly onRestart: () => void;
  readonly log: (line: string) => void;
  readonly python?: string;
  readonly script?: string;
  readonly models?: string;
  /** Relay's voice prints (learned from calls the meeting app named). */
  readonly voices?: string;
  /** MeetingTranscriber's speakers.json, when it is there. */
  readonly mtSpeakers?: string;
}

export class AsrWorker implements Asr {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private seq = 0;
  private readonly jobs = new Map<
    string,
    { resolve(v: Record<string, unknown>): void; reject(e: Error): void }
  >();
  private readonly closing = new Map<string, (() => void)[]>();
  private started = false;
  private stopped = false;

  constructor(private readonly deps: AsrWorkerDeps) {}

  /** Whether the worker can run here (its venv and script exist). */
  static available(python = asrPython(), script = ASR_SCRIPT): boolean {
    return existsSync(python) && existsSync(script);
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child !== null) return this.child;
    const python = this.deps.python ?? asrPython();
    const c = spawn(python, [this.deps.script ?? ASR_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        RELAY_ASR_MODELS: this.deps.models ?? asrModels(),
        RELAY_VOICES: this.deps.voices ?? "",
        RELAY_MT_SPEAKERS: this.deps.mtSpeakers ?? "",
        PATH: ["/opt/homebrew/bin", "/usr/local/bin", process.env["PATH"] ?? "/usr/bin:/bin"].join(
          ":",
        ),
      },
    });
    this.child = c;
    const restarted = this.started;
    this.started = true;
    c.stdout.setEncoding("utf8");
    c.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl = this.buf.indexOf("\n");
      while (nl >= 0) {
        this.heard(this.buf.slice(0, nl));
        this.buf = this.buf.slice(nl + 1);
        nl = this.buf.indexOf("\n");
      }
    });
    c.stderr.setEncoding("utf8");
    c.stderr.on("data", (s: string) => {
      for (const line of s.split("\n"))
        if (line.trim() !== "" && !line.includes("HF_TOKEN")) this.deps.log(`asr: ${line.trim()}`);
    });
    c.on("error", (e) => {
      this.deps.log(`asr: ${e.message}`);
    });
    c.on("exit", (code, signal) => {
      this.child = null;
      this.buf = "";
      const why = new Error(`the transcription worker stopped (${signal ?? String(code)})`);
      for (const j of this.jobs.values()) j.reject(why);
      this.jobs.clear();
      for (const waiters of this.closing.values()) for (const w of waiters) w();
      this.closing.clear();
      if (!this.stopped) this.deps.log(`asr: worker ended (${signal ?? String(code)})`);
    });
    if (restarted)
      queueMicrotask(() => {
        this.deps.onRestart();
      });
    return c;
  }

  private send(cmd: Record<string, unknown>): void {
    if (this.stopped) return;
    this.ensure().stdin.write(`${JSON.stringify(cmd)}\n`);
  }

  private heard(raw: string): void {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (ev["ev"] === "line") {
      const r = WorkerLine.safeParse(ev);
      if (r.success) this.deps.onLine(r.data);
      return;
    }
    if (ev["ev"] === "turns") {
      const r = WorkerTurns.safeParse(ev);
      if (r.success) this.deps.onTurns(r.data);
      return;
    }
    if (ev["ev"] === "closed" && typeof ev["meeting"] === "string") {
      for (const w of this.closing.get(ev["meeting"]) ?? []) w();
      this.closing.delete(ev["meeting"]);
      return;
    }
    const req = typeof ev["req"] === "string" ? ev["req"] : null;
    if ((ev["ev"] === "result" || ev["ev"] === "error") && req !== null) {
      const job = this.jobs.get(req);
      this.jobs.delete(req);
      if (ev["ev"] === "result") job?.resolve(ev);
      else
        job?.reject(new Error(typeof ev["message"] === "string" ? ev["message"] : "worker error"));
      return;
    }
    if (ev["ev"] === "log" || ev["ev"] === "error") this.deps.log(`asr: ${String(ev["message"])}`);
  }

  private job(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.seq += 1;
    const req = `j${String(this.seq)}`;
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
    this.jobs.set(req, { resolve, reject });
    this.send({ op, req, ...args });
    return promise;
  }

  open(meeting: string, app: number, mic: number, human: string): void {
    this.send({ op: "open", meeting, app, mic, human });
  }

  learn(meeting: string, label: number, name: string): void {
    this.send({ op: "learn", meeting, label, name });
  }

  audio(meeting: string, track: "app" | "mic", at: number, pcm: Uint8Array): void {
    this.send({
      op: "audio",
      meeting,
      track,
      at,
      pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64"),
    });
  }

  close(meeting: string): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    if (this.child === null) {
      resolve(undefined);
      return promise;
    }
    this.closing.set(meeting, [
      ...(this.closing.get(meeting) ?? []),
      () => {
        resolve(undefined);
      },
    ]);
    this.send({ op: "close", meeting });
    return promise;
  }

  async aec(app: string, mic: string, out: string): Promise<void> {
    await this.job("aec", { app, mic, out });
  }

  async transcribe(wav: string): Promise<Segment[]> {
    const r = await this.job("transcribe", { wav });
    return z
      .array(z.object({ start: z.number(), end: z.number(), text: z.string() }))
      .parse(r["segments"]);
  }

  async diarize(wav: string): Promise<Turn[]> {
    const r = await this.job("diarize", { wav, models: this.deps.models ?? asrModels() });
    return z
      .array(z.object({ start: z.number(), end: z.number(), speaker: z.number() }))
      .parse(r["turns"]);
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill("SIGTERM");
    this.child = null;
  }
}
