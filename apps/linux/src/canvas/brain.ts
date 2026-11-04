// The canvas self's mind: one full omp agent per room (`omp --mode rpc`, agent-config.ts), with the
// owner's normal tools, the room's board as host tools (the host runs them, so a card lands the
// moment the model asks), the canvas guard (guard.ts) as its only extension, and a saved session
// in the room's own directory so it remembers the whole session, survives an idle stop and resumes
// where it was. Turns are serialized; a note that arrives mid-turn is steered into the running turn.
// The cost guard lives here: requests and tokens per room, minutes per turn, idle stop.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { MODELS, type ModelKey } from "@relay/canvas-live/shared";
import { mindArgs, type CanvasAgentConfig } from "./agent-config";
import { guardExtension } from "./guard";

/** One host-run tool the mind can call (the board's canvas_act, canvas_read). */
export interface HostTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>;
}

/** What a turn streams back. */
export interface TurnHandlers {
  /** Text the agent says, as it streams. */
  text(delta: string): void;
  /** The text block it was saying is complete. */
  textEnd(): void;
  /** A tool started: its name and the intent the agent gave for it (empty when none). */
  tool(name: string, intent: string): void;
  /** A tool call's arguments as the model writes them (all of it so far), before the call runs. */
  drafting(args: string): void;
}

export interface MindUsage {
  /** Model requests (each tool round trip is one). */
  requests: number;
  /** Tokens as the provider reports them (input, output, cache reads and writes). */
  tokens: number;
  costUsd: number;
}

export interface MindSetup {
  readonly roomId: string;
  readonly slug: string;
  /** The canvas identity, chat and memory, after omp's own system prompt. */
  readonly systemPrompt: string;
  readonly model: ModelKey;
  readonly tools: readonly HostTool[];
}

/** What the agent needs of its mind; tests drive a scripted fake. */
export interface CanvasMind {
  /** One turn; resolves when the agent yields (or the turn was stopped). Serialized. */
  turn(message: string, on: TurnHandlers): Promise<void>;
  /** Delivers `message` into the running turn; false when no turn is running. */
  steer(message: string): boolean;
  /** The model the next turn runs on. */
  setModel(model: ModelKey): void;
  readonly usage: MindUsage;
  /** Why it takes no more turns (the room's budget is spent), else null. */
  readonly exhausted: string | null;
  dispose(): void;
}

export type MindFactory = (setup: MindSetup) => CanvasMind;

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
 * The config overlay the minds run with: memory off (no recall round trip and no retained
 * memories from a board session). Written once into `dir`; returns its path.
 */
export function mindConfigOverlay(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "canvas-mind.yml");
  writeFileSync(path, 'memory:\n  backend: "off"\n');
  return path;
}

export interface OmpMindOptions {
  /** Absolute omp binary. */
  readonly omp: string;
  /** `--profile`; null runs on omp's default (unprofiled) sign-ins. */
  readonly profile: string | null;
  /** `--config` overlays, in order. */
  readonly configs: readonly string[];
  /** Where each room keeps its session and guard: `<stateDir>/<roomId>/`. */
  readonly stateDir: string;
  /** The agent home: the agent's working directory; its work/ is where it may write. */
  readonly agentHome: string;
  /** The boards folder: the room's own board file is writable too. */
  readonly canvasDir: string;
  readonly config: CanvasAgentConfig;
  readonly log: (line: string) => void;
}

/** The production factory: an `OmpMind` per room. */
export function ompMinds(options: OmpMindOptions): MindFactory {
  return (setup) => new OmpMind(options, setup);
}

interface Frame {
  type: string;
  id?: string;
  success?: boolean;
  error?: string;
  status?: string;
  toolName?: string;
  intent?: string;
  arguments?: Record<string, unknown>;
  assistantMessageEvent?: { type: string; delta?: string };
  message?: { role?: string; usage?: { totalTokens?: number; cost?: { total?: number } }; stopReason?: string; errorMessage?: string };
}

interface Running {
  readonly id: string;
  readonly on: TurnHandlers;
  readonly done: (error: Error | null) => void;
}

export class OmpMind implements CanvasMind {
  readonly usage: MindUsage = { requests: 0, tokens: 0, costUsd: 0 };
  exhausted: string | null = null;
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private ready: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, (frame: Frame) => void>();
  private running: Running | null = null;
  private seq = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private idleTimer: Timer | undefined;
  private model: ModelKey;
  /** The model the live process is on (null: not started, or it must be told). */
  private procModel: ModelKey | null = null;
  private disposed = false;
  private readonly dir: string;
  private readonly guard: string;

  constructor(
    private readonly options: OmpMindOptions,
    private readonly setup: MindSetup,
  ) {
    this.model = setup.model;
    this.dir = join(options.stateDir, setup.roomId);
    mkdirSync(join(this.dir, "session"), { recursive: true });
    this.guard = join(this.dir, "canvas-guard.ts");
    writeFileSync(
      this.guard,
      guardExtension({
        cwd: options.agentHome,
        home: homedir(),
        writeRoots: [join(options.agentHome, "work")],
        writeFiles: [join(options.canvasDir, `${setup.slug}.json`)],
      }),
    );
    this.start();
  }

  setModel(model: ModelKey): void {
    this.model = model;
  }

  turn(message: string, on: TurnHandlers): Promise<void> {
    const job = this.chain.then(() => this.run(message, on));
    this.chain = job.catch(() => undefined);
    return job;
  }

  steer(message: string): boolean {
    if (this.running === null || this.proc === null) return false;
    this.send({ type: "steer", message });
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.idleTimer);
    this.stop();
  }

  private start(): void {
    const { options, setup } = this;
    const args = mindArgs({
      omp: options.omp,
      profile: options.profile,
      configs: options.configs,
      baseConfig: join(homedir(), ".omp", "agent", "config.yml"),
      cwd: options.agentHome,
      sessionDir: join(this.dir, "session"),
      guard: this.guard,
      model: this.model,
      effort: options.config.effort,
      appendSystemPrompt: setup.systemPrompt,
    });
    const started = performance.now();
    const proc = Bun.spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: options.agentHome,
      // launchd starts the host with no locale; without one omp reads the non-ASCII in its
      // arguments (the "1 · " numbering, the chat) as Latin-1 and writes mojibake onto the board.
      env: { ...process.env, LANG: process.env["LANG"] ?? "en_US.UTF-8", LC_CTYPE: process.env["LC_CTYPE"] ?? "en_US.UTF-8" },
    });
    this.proc = proc;
    this.procModel = this.model;
    const ready = Promise.withResolvers<undefined>();
    this.ready = ready.promise.then(async () => {
      // The room's own session (resumed after an idle stop), the board tools, and only the events the turn reads.
      const opened = await this.request({ type: "open_session", sessionDir: join(this.dir, "session") });
      if (opened.success === false) throw new Error(opened.error ?? "open_session failed");
      const tools = await this.request({
        type: "set_host_tools",
        tools: setup.tools.map((tool) => ({ name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters, loadMode: "essential" })),
      });
      if (tools.success === false) throw new Error(tools.error ?? "set_host_tools failed");
      await this.request({ type: "set_event_filter", events: ["message_update", "message_end", "tool_execution_start"], messageUpdates: "delta" });
      options.log(`canvas mind ${setup.slug}: ${MODELS[this.model].id} (${options.config.effort}) ready in ${(performance.now() - started).toFixed(0)} ms`);
    });
    // Unhandled until a turn awaits it; a dead process fails that turn instead.
    this.ready.catch(() => undefined);
    void this.read(proc, () => {
      ready.resolve(undefined);
    }, ready.reject);
    void this.drainStderr(proc);
  }

  private stop(): void {
    const proc = this.proc;
    this.proc = null;
    this.procModel = null;
    if (proc === null) return;
    void proc.stdin.end();
    proc.kill();
  }

  private async run(message: string, on: TurnHandlers): Promise<void> {
    if (this.disposed) throw new Error("canvas mind disposed");
    if (this.exhausted !== null) throw new Error(this.exhausted);
    clearTimeout(this.idleTimer);
    if (this.proc === null) this.start();
    await this.ready;
    if (this.procModel !== this.model) {
      const [provider = "anthropic", ...rest] = MODELS[this.model].id.split("/");
      const set = await this.request({ type: "set_model", provider, modelId: rest.join("/") });
      if (set.success === false) throw new Error(set.error ?? "set_model failed");
      this.procModel = this.model;
    }
    this.seq += 1;
    const id = `turn${String(this.seq)}`;
    const finished = Promise.withResolvers<undefined>();
    this.running = {
      id,
      on,
      done: (error) => {
        if (error === null) finished.resolve(undefined);
        else finished.reject(error);
      },
    };
    const limit = setTimeout(() => {
      this.options.log(`canvas mind ${this.setup.slug}: turn ran past ${String(Math.round(this.options.config.maxTurnMs / 60_000))} min, stopping it`);
      this.send({ type: "abort" });
    }, this.options.config.maxTurnMs);
    try {
      this.send({ type: "prompt", id, message });
      await finished.promise;
    } finally {
      clearTimeout(limit);
      this.running = null;
      this.idleTimer = setTimeout(() => {
        if (this.running === null && this.proc !== null) {
          this.options.log(`canvas mind ${this.setup.slug}: idle, stopping omp (the session resumes on the next note)`);
          this.stop();
        }
      }, this.options.config.idleStopMs);
    }
  }

  private send(command: Record<string, unknown>): void {
    const proc = this.proc;
    if (proc === null) return;
    void proc.stdin.write(`${JSON.stringify(command)}\n`);
    void proc.stdin.flush();
  }

  private request(command: Record<string, unknown>): Promise<Frame> {
    this.seq += 1;
    const id = `r${String(this.seq)}`;
    const { promise, resolve } = Promise.withResolvers<Frame>();
    this.pending.set(id, resolve);
    this.send({ ...command, id });
    return promise;
  }

  /** Counts a finished model request against the room's budget; stops the turn once it is spent. */
  private count(frame: Frame): void {
    const usage = frame.message?.usage;
    if (frame.message?.role !== "assistant" || usage === undefined) return;
    this.usage.requests += 1;
    this.usage.tokens += usage.totalTokens ?? 0;
    this.usage.costUsd += usage.cost?.total ?? 0;
    const { maxRequests, maxTokens } = this.options.config;
    if (this.exhausted === null && (this.usage.requests >= maxRequests || this.usage.tokens >= maxTokens)) {
      this.exhausted = `this canvas session used its budget (${String(this.usage.requests)} model requests, ${String(Math.round(this.usage.tokens / 1000))}k tokens, about $${this.usage.costUsd.toFixed(2)})`;
      this.options.log(`canvas mind ${this.setup.slug}: ${this.exhausted}; stopping`);
      this.send({ type: "abort" });
    }
  }

  private async hostTool(proc: Subprocess<"pipe", "pipe", "pipe">, frame: Frame): Promise<void> {
    const tool = this.setup.tools.find((t) => t.name === frame.toolName);
    let result: { text: string; isError?: boolean };
    try {
      result = tool === undefined ? { text: `no host tool ${frame.toolName ?? ""}`, isError: true } : await tool.run(frame.arguments ?? {});
    } catch (error) {
      result = { text: error instanceof Error ? error.message : String(error), isError: true };
    }
    if (this.proc !== proc) return;
    this.send({ type: "host_tool_result", id: frame.id, result: { content: [{ type: "text", text: result.text }] }, ...(result.isError === true ? { isError: true } : {}) });
  }

  private async drainStderr(proc: Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
    const decoder = new TextDecoder();
    let tail = "";
    for await (const chunk of proc.stderr) tail = (tail + decoder.decode(chunk, { stream: true })).slice(-2000);
    if (!this.disposed && tail.trim() !== "") this.options.log(`canvas mind ${this.setup.slug} stderr: ${tail.trim().split("\n").slice(-3).join(" | ")}`);
  }

  private async read(proc: Subprocess<"pipe", "pipe", "pipe">, ready: () => void, failed: (error: Error) => void): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    let isReady = false;
    /** The tool call arguments being written now. */
    let draft = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() === "") continue;
        let frame: Frame;
        try {
          frame = JSON.parse(line) as Frame;
        } catch {
          continue;
        }
        const running = this.running;
        if (frame.type === "ready") {
          isReady = true;
          ready();
        } else if (frame.type === "response" && frame.id !== undefined && this.pending.has(frame.id)) {
          this.pending.get(frame.id)?.(frame);
          this.pending.delete(frame.id);
        } else if (frame.type === "response" && frame.success === false && running !== null && frame.id === running.id) {
          running.done(new Error(frame.error ?? "prompt failed"));
        } else if (frame.type === "host_tool_call") {
          void this.hostTool(proc, frame);
        } else if (frame.type === "message_update" && running !== null) {
          const event = frame.assistantMessageEvent;
          if (event?.type === "text_delta" && event.delta !== undefined) running.on.text(event.delta);
          else if (event?.type === "text_end") running.on.textEnd();
          else if (event?.type === "toolcall_start") draft = "";
          else if (event?.type === "toolcall_delta" && event.delta !== undefined) {
            draft += event.delta;
            running.on.drafting(draft);
          }
        } else if (frame.type === "message_end") {
          this.count(frame);
        } else if (frame.type === "tool_execution_start" && running !== null) {
          running.on.tool(frame.toolName ?? "", frame.intent ?? "");
        } else if (frame.type === "prompt_result" && running !== null && frame.id === running.id) {
          running.done(frame.status === "error" ? new Error(frame.error ?? "the turn failed") : null);
        }
      }
    }
    const error = new Error(`canvas mind ${this.setup.slug} exited`);
    if (!isReady) failed(error);
    for (const resolve of this.pending.values()) resolve({ type: "response", success: false, error: error.message });
    this.pending.clear();
    if (this.proc === proc) {
      this.proc = null;
      this.procModel = null;
      this.running?.done(error);
      if (!this.disposed) this.options.log(error.message);
    }
  }
}
