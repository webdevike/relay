// The speech models calls run on, all local and all reused from Eva's voice stack:
//   - ears: eva-realtime's `py/call_ears_worker.py` (silero VAD + mlx-whisper), one process for
//     every call, each call its own stream inside it;
//   - filler: eva-realtime's `py/brain_worker.py` in `filler` mode (Qwen3-0.6B on MLX);
//   - mouth: the warm pocket-tts server Eva's other voice tools use (`pocket-tts serve`, started
//     here the way `.omp/tools/pocket-say.ts` starts it when it is not up).
// Both Python workers run on eva-realtime's own venv, start with the first call and stop once no
// call has needed them for IDLE_STOP_MS, so an idle host holds no models.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { CALL_OUTPUT_RATE } from "@relay/protocol";
import type { Subprocess } from "bun";
import type { Ears, EarsEvents, VoiceStack } from "./call";
import { sentences } from "./speech";

/** Workers no call has used for this long are stopped. */
export const IDLE_STOP_MS = 30 * 60_000;
/** A worker gets this long to load its models (the first run also downloads them). */
const READY_TIMEOUT_MS = 180_000;
/** A filler that takes longer than this is too late to be useful. */
const FILLER_TIMEOUT_MS = 5_000;
/** Longest filler said; the brain's longer lines are dropped. */
const MAX_FILLER_WORDS = 8;
/** Audio goes to the phone in pieces of at least this many bytes (100 ms at CALL_OUTPUT_RATE). */
const AUDIO_PIECE_BYTES = (CALL_OUTPUT_RATE / 10) * 2;

export interface EvaRealtimeVoiceConfig {
  /** eva-realtime's app root (holds `py/` and `.venv/`). */
  readonly root: string;
  /** Base URL of the pocket-tts server, e.g. http://127.0.0.1:8853. */
  readonly ttsUrl: string;
  /** pocket-tts voice for threads that name none, and the one a started server preloads. */
  readonly defaultVoice: string;
  readonly log: (line: string) => void;
}

type Line = Record<string, unknown>;

/** One Python sidecar speaking line-delimited JSON on stdin/stdout; its stderr goes to the host log. */
class LineWorker {
  readonly ready: Promise<void>;
  private readonly proc: Subprocess<"pipe", "pipe", "pipe">;
  private alive = true;

  constructor(
    readonly name: string,
    python: string,
    script: string,
    private readonly onLine: (line: Line) => void,
    private readonly onExit: (reason: string) => void,
    log: (line: string) => void,
  ) {
    this.proc = Bun.spawn([python, script], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PYTHONUNBUFFERED: "1", TOKENIZERS_PARALLELISM: "false" },
    });
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Promise<void> resolver
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.ready = promise;
    const timer = setTimeout(() => {
      reject(new Error(`${name} did not load within ${String(READY_TIMEOUT_MS / 1000)} s`));
      this.stop();
    }, READY_TIMEOUT_MS);
    void this.readLines(this.proc.stdout, (line) => {
      if (line["ready"] === true) {
        clearTimeout(timer);
        resolve();
        return;
      }
      this.onLine(line);
    });
    void this.readLines(this.proc.stderr, null, (text) => {
      // The workers' own logs start with their tag; library warnings stay out of the host log.
      if (text.startsWith("[")) log(`voice ${text}`);
    });
    void this.proc.exited.then((code) => {
      this.alive = false;
      clearTimeout(timer);
      const reason = `${name} exited (${String(code)})`;
      reject(new Error(reason));
      this.onExit(reason);
    });
  }

  get isAlive(): boolean {
    return this.alive;
  }

  write(line: Line): void {
    if (!this.alive) return;
    void this.proc.stdin.write(`${JSON.stringify(line)}\n`);
    void this.proc.stdin.flush();
  }

  stop(): void {
    if (!this.alive) return;
    this.write({ cmd: "quit" });
    void this.proc.stdin.end();
    setTimeout(() => {
      if (this.alive) this.proc.kill();
    }, 2_000);
  }

  private async readLines(stream: ReadableStream<Uint8Array>, json: ((line: Line) => void) | null, raw?: (text: string) => void): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const text = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (text === "") continue;
        if (json === null) {
          raw?.(text);
          continue;
        }
        try {
          json(JSON.parse(text) as Line);
        } catch {
          // Not a protocol line.
        }
      }
    }
  }
}

export class EvaRealtimeVoice implements VoiceStack {
  private earsWorker: LineWorker | null = null;
  private brainWorker: LineWorker | null = null;
  private readonly listeners = new Map<string, EarsEvents>();
  private readonly fillers = new Map<number, (text: string) => void>();
  private streams = 0;
  private fillerSeq = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private ttsUp: Promise<void> | null = null;

  constructor(private readonly config: EvaRealtimeVoiceConfig) {}

  private get python(): string {
    return join(this.config.root, ".venv", "bin", "python");
  }

  /**
   * Loads the ears, the filler brain and pocket-tts ahead of a call (the phone opened an
   * assistant's thread), so the call does not wait ~10 s for cold models. With no call they stop
   * IDLE_STOP_MS after the last warm-up.
   */
  warm(): void {
    if (!existsSync(this.python)) return;
    this.startModels();
    this.earsProcess().ready.catch(() => undefined);
    if (this.streams === 0) this.scheduleIdle();
  }

  async ears(events: EarsEvents): Promise<Ears> {
    if (!existsSync(this.python)) throw new Error(`no Python venv at ${this.python} (eva-realtime README: Layout)`);
    this.clearIdle();
    this.streams += 1;
    this.startModels();
    const worker = this.earsProcess();
    try {
      await worker.ready;
    } catch (error) {
      this.release();
      throw error;
    }
    const id = `s${String(this.streams)}-${crypto.randomUUID().slice(0, 8)}`;
    this.listeners.set(id, events);
    worker.write({ cmd: "open", call: id });
    let closed = false;
    return {
      audio: (pcm) => {
        worker.write({ cmd: "audio", call: id, pcm });
      },
      reset: () => {
        worker.write({ cmd: "reset", call: id });
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.listeners.delete(id);
        worker.write({ cmd: "close", call: id });
        this.release();
      },
    };
  }

  filler(heard: string): Promise<string> {
    const worker = this.brain();
    const id = (this.fillerSeq += 1);
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const timer = setTimeout(() => {
      this.fillers.delete(id);
      reject(new Error("filler took too long"));
    }, FILLER_TIMEOUT_MS);
    this.fillers.set(id, (text) => {
      clearTimeout(timer);
      // A 0.6B model rambles now and then; a long or odd line is worse than none.
      const first = sentences(text)[0] ?? "";
      resolve(first.split(/\s+/).length <= MAX_FILLER_WORDS ? first : "");
    });
    worker.ready.then(
      () => {
        worker.write({ cmd: "gen", id, mode: "filler", text: heard });
      },
      (error: unknown) => {
        clearTimeout(timer);
        this.fillers.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
    return promise;
  }

  async *speak(text: string, voice: string | undefined, signal: AbortSignal): AsyncIterable<Uint8Array> {
    await this.ensureTts();
    const form = new FormData();
    form.set("text", text);
    form.set("voice_url", voice ?? this.config.defaultVoice);
    const response = await fetch(`${this.config.ttsUrl}/tts`, { method: "POST", body: form, signal });
    if (!response.ok || response.body === null) throw new Error(`pocket-tts ${String(response.status)}`);
    let header: Uint8Array = new Uint8Array(0);
    let dataStarted = false;
    let pending: Uint8Array = new Uint8Array(0);
    for await (const chunk of response.body as ReadableStream<Uint8Array>) {
      let bytes: Uint8Array = chunk;
      if (!dataStarted) {
        header = concat(header, bytes);
        const start = wavDataStart(header);
        if (start === null) continue;
        dataStarted = true;
        bytes = header.subarray(start);
      }
      pending = concat(pending, bytes);
      if (pending.byteLength < AUDIO_PIECE_BYTES) continue;
      // Whole samples only; an odd trailing byte waits for the next chunk.
      const cut = pending.byteLength - (pending.byteLength % 2);
      yield pending.slice(0, cut);
      pending = pending.slice(cut);
    }
    if (pending.byteLength >= 2) yield pending.slice(0, pending.byteLength - (pending.byteLength % 2));
  }

  /** Stops both workers now (host shutdown). */
  stop(): void {
    this.clearIdle();
    this.earsWorker?.stop();
    this.brainWorker?.stop();
  }

  private earsProcess(): LineWorker {
    if (this.earsWorker?.isAlive === true) return this.earsWorker;
    const worker: LineWorker = new LineWorker(
      "ears",
      this.python,
      join(this.config.root, "py", "call_ears_worker.py"),
      (line) => {
        const events = this.listeners.get(typeof line["call"] === "string" ? line["call"] : "");
        if (events === undefined) return;
        if (line["event"] === "speech_start") events.speechStart();
        else if (line["event"] === "transcript") events.transcript(typeof line["text"] === "string" ? line["text"] : "");
        else if (typeof line["error"] === "string") this.config.log(`voice ears: ${line["error"]}`);
      },
      (reason) => {
        if (this.earsWorker === worker) this.earsWorker = null;
        const listeners = [...this.listeners.values()];
        this.listeners.clear();
        for (const events of listeners) events.failed(reason);
      },
      this.config.log,
    );
    this.earsWorker = worker;
    this.config.log("voice: starting ears (silero VAD + mlx-whisper)");
    return worker;
  }

  private brain(): LineWorker {
    if (this.brainWorker?.isAlive === true) return this.brainWorker;
    const worker: LineWorker = new LineWorker(
      "brain",
      this.python,
      join(this.config.root, "py", "brain_worker.py"),
      (line) => {
        const id = typeof line["id"] === "number" ? line["id"] : -1;
        const done = this.fillers.get(id);
        if (done === undefined) return;
        this.fillers.delete(id);
        done(typeof line["text"] === "string" ? line["text"] : "");
      },
      () => {
        if (this.brainWorker === worker) this.brainWorker = null;
      },
      this.config.log,
    );
    this.brainWorker = worker;
    this.config.log("voice: starting filler brain (Qwen3-0.6B)");
    // MLX compiles on the first generation; pay that now, not on the first slow reply.
    void worker.ready.then(() => {
      worker.write({ cmd: "gen", id: 0, mode: "filler", text: "Hello?" });
    }, () => undefined);
    return worker;
  }

  /** The pocket-tts server, started (and waited for) when it is not answering. */
  private ensureTts(): Promise<void> {
    this.ttsUp ??= this.startTts().finally(() => {
      this.ttsUp = null;
    });
    return this.ttsUp;
  }

  private async startTts(): Promise<void> {
    const healthy = (): Promise<boolean> =>
      fetch(`${this.config.ttsUrl}/health`, { signal: AbortSignal.timeout(500) }).then(
        (response) => response.ok,
        () => false,
      );
    if (await healthy()) return;
    const port = new URL(this.config.ttsUrl).port;
    this.config.log(`voice: starting pocket-tts on ${port}`);
    Bun.spawn(["pocket-tts", "serve", "--port", port, "--default-voice", this.config.defaultVoice], { stdio: ["ignore", "ignore", "ignore"] }).unref();
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (await healthy()) return;
      await Bun.sleep(250);
    }
    throw new Error(`pocket-tts did not come up on ${this.config.ttsUrl}`);
  }

  /** The filler brain and the mouth, started (not awaited) so the first turn does not pay for them. */
  private startModels(): void {
    this.brain().ready.catch(() => undefined);
    this.ensureTts().catch((error: unknown) => {
      this.config.log(`voice: pocket-tts not ready: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** One ears stream closed; with none left the workers stop after IDLE_STOP_MS. */
  private release(): void {
    this.streams = Math.max(0, this.streams - 1);
    if (this.streams === 0) this.scheduleIdle();
  }

  private scheduleIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.config.log("voice: no calls for a while, stopping the speech models");
      this.earsWorker?.stop();
      this.brainWorker?.stop();
    }, IDLE_STOP_MS);
  }

  private clearIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
}

/**
 * Offset of the PCM samples in a streamed WAV once its header has arrived, null before. Checks
 * the format is what calls send (PCM16 mono at CALL_OUTPUT_RATE) and throws when it is not.
 */
export function wavDataStart(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("pocket-tts did not answer with a WAV stream");
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === "data") return at + 8;
    if (id === "fmt ") {
      if (at + 8 + 16 > bytes.byteLength) return null;
      const channels = view.getUint16(at + 10, true);
      const rate = view.getUint32(at + 12, true);
      const bits = view.getUint16(at + 22, true);
      if (channels !== 1 || rate !== CALL_OUTPUT_RATE || bits !== 16) throw new Error(`pocket-tts sends ${String(channels)} ch ${String(rate)} Hz ${String(bits)}-bit, calls need mono ${String(CALL_OUTPUT_RATE)} Hz 16-bit`);
    }
    at += 8 + size + (size % 2);
  }
  return null;
}
