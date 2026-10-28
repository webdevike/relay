// The canvas agent's model: a warm `omp --mode rpc` process per room and model, with the agent's
// identity and its chat in the cached system prompt. Each request starts a fresh omp session
// (a few ms) and streams text deltas back. No tools: the model answers in the line DSL (dsl.ts)
// that the agent parses while tokens stream, so edits start before the reply finishes.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { MODELS, type ModelKey } from "@relay/canvas-live/shared";

/** What the agent needs of a model; tests drive a scripted fake. */
export interface CanvasBrain {
  /** Settles once the process is up (or rejects when it never comes up). */
  readonly ready: Promise<void>;
  /** One completion in a fresh context; `onDelta` gets the text as it streams. Serialized per brain. */
  run(message: string, onDelta: (delta: string) => void): Promise<void>;
  dispose(): void;
}

export type BrainFactory = (systemPrompt: string, model: ModelKey) => CanvasBrain;

interface RpcFrame {
  type: string;
  id?: string;
  success?: boolean;
  error?: string;
  assistantMessageEvent?: { type: string; delta?: string };
}

/**
 * The omp binary: `$RELAY_CANVAS_OMP`, else `omp` on PATH or in the usual install dirs (launchd's
 * PATH has no ~/.local/bin). Null when none is found.
 */
export function resolveOmp(env: Record<string, string | undefined> = process.env): string | null {
  const override = env["RELAY_CANVAS_OMP"];
  if (override !== undefined && override !== "") return override;
  const home = env["HOME"] ?? homedir();
  const dirs = [...(env["PATH"] ?? "").split(":"), join(home, ".local", "bin"), join(home, ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of dirs) {
    if (dir === "") continue;
    const candidate = join(dir, "omp");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The config overlay the brains run with: memory off (no recall round trip before the first
 * token). Written once into `dir`; returns its path.
 */
export function brainConfigOverlay(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "canvas-brain.yml");
  writeFileSync(path, 'memory:\n  backend: "off"\n');
  return path;
}

export interface OmpBrainOptions {
  /** Absolute omp binary. */
  readonly omp: string;
  /** `--profile`. */
  readonly profile: string;
  /** `--config` overlays, in order. */
  readonly configs: readonly string[];
  readonly log: (line: string) => void;
  /** Keep-alive ping interval (holds the TLS connection and the provider's prompt cache). */
  readonly keepWarmMs?: number;
}

/** The production brain factory: a warm `omp --mode rpc --no-tools --thinking off` per room and model. */
export function ompBrains(options: OmpBrainOptions): BrainFactory {
  return (systemPrompt, model) => new OmpBrain(options, MODELS[model].id, systemPrompt);
}

export class OmpBrain implements CanvasBrain {
  readonly ready: Promise<void>;
  private readonly proc: Subprocess<"pipe", "pipe", "pipe">;
  private readonly pending = new Map<string, (frame: RpcFrame) => void>();
  private onDelta: ((delta: string) => void) | null = null;
  private onEnd: (() => void) | null = null;
  private seq = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private warmTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(
    private readonly options: OmpBrainOptions,
    readonly modelId: string,
    systemPrompt: string,
  ) {
    const configs = [join(homedir(), ".omp", "agent", "config.yml"), ...options.configs].flatMap((config) => ["--config", config]);
    this.proc = Bun.spawn(
      [
        options.omp,
        "--profile", options.profile,
        ...configs,
        "--mode", "rpc", "--no-ui", "--no-tools", "--no-skills", "--no-rules", "--no-extensions",
        "--no-lsp", "--no-session", "--no-title", "--thinking", "off",
        "--model", modelId,
        "--system-prompt", systemPrompt,
      ],
      // launchd starts the host with no locale; without one omp reads the non-ASCII in its
      // arguments (the system prompt's "1 \u00b7 " numbering, the chat) as Latin-1, and the model then
      // writes mojibake ("\u00c2\u00b7") onto the board.
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: homedir(), env: { ...process.env, LANG: process.env["LANG"] ?? "en_US.UTF-8", LC_CTYPE: process.env["LC_CTYPE"] ?? "en_US.UTF-8" } },
    );
    const started = performance.now();
    const ready = Promise.withResolvers<undefined>();
    this.ready = ready.promise;
    void this.read(() => {
      options.log(`canvas brain ${modelId} ready in ${(performance.now() - started).toFixed(0)} ms`);
      ready.resolve(undefined);
    }, ready.reject);
    // Unhandled until someone awaits it; a dead brain fails each run instead.
    this.ready.catch(() => undefined);
    void this.drainStderr();
    const every = options.keepWarmMs ?? 4 * 60_000;
    if (every > 0) {
      const ping = (): void => {
        this.run("Reply with just: ok", () => undefined).catch(() => undefined);
      };
      ping();
      this.warmTimer = setInterval(ping, every);
    }
  }

  private async drainStderr(): Promise<void> {
    const decoder = new TextDecoder();
    let tail = "";
    for await (const chunk of this.proc.stderr) tail = (tail + decoder.decode(chunk, { stream: true })).slice(-2000);
    if (!this.disposed && tail.trim() !== "") this.options.log(`canvas brain ${this.modelId} stderr: ${tail.trim().split("\n").slice(-3).join(" | ")}`);
  }

  private async read(ready: () => void, failed: (error: Error) => void): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    let isReady = false;
    for await (const chunk of this.proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() === "") continue;
        let frame: RpcFrame;
        try {
          frame = JSON.parse(line) as RpcFrame;
        } catch {
          continue;
        }
        if (frame.type === "ready") {
          isReady = true;
          ready();
        } else if (frame.type === "response" && frame.id !== undefined) {
          this.pending.get(frame.id)?.(frame);
          this.pending.delete(frame.id);
        } else if (frame.type === "message_update" && frame.assistantMessageEvent?.type === "text_delta") {
          this.onDelta?.(frame.assistantMessageEvent.delta ?? "");
        } else if (frame.type === "agent_end") {
          this.onEnd?.();
        }
      }
    }
    const error = new Error(`canvas brain ${this.modelId} exited`);
    if (!isReady) failed(error);
    for (const resolve of this.pending.values()) resolve({ type: "response", success: false, error: error.message });
    this.pending.clear();
    this.onEnd?.();
    if (!this.disposed) this.options.log(error.message);
  }

  private request(command: Record<string, unknown>): Promise<RpcFrame> {
    this.seq += 1;
    const id = `r${String(this.seq)}`;
    const { promise, resolve } = Promise.withResolvers<RpcFrame>();
    this.pending.set(id, resolve);
    void this.proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    void this.proc.stdin.flush();
    return promise;
  }

  run(message: string, onDelta: (delta: string) => void): Promise<void> {
    const job = this.chain.then(async () => {
      await this.ready;
      if (this.disposed) throw new Error("canvas brain disposed");
      await this.request({ type: "new_session" });
      const ended = Promise.withResolvers<undefined>();
      this.onEnd = () => {
        ended.resolve(undefined);
      };
      this.onDelta = onDelta;
      try {
        const response = await this.request({ type: "prompt", message });
        if (response.success === false) throw new Error(response.error ?? "prompt failed");
        await ended.promise;
      } finally {
        this.onDelta = null;
        this.onEnd = null;
      }
    });
    this.chain = job.catch(() => undefined);
    return job;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.warmTimer ?? undefined);
    void this.proc.stdin.end();
    this.proc.kill();
  }
}
