// How the canvas self runs: a full omp agent (its own session, the normal tool set, the room's
// board as host tools) on Opus at low effort by default, with a cost guard per room. Read once at
// host start from the environment, so a host can be tuned without a rebuild:
//   RELAY_CANVAS_MODEL       opus | sonnet | haiku          the room's starting model (the room's model toggle switches it live)
//   RELAY_CANVAS_EFFORT      low | medium                   thinking effort
//   RELAY_CANVAS_MAX_TURNS   model requests per room (each tool round trip is one)
//   RELAY_CANVAS_MAX_TOKENS  tokens per room, as the provider reports them (input, output, cache reads and writes)
//   RELAY_CANVAS_MAX_TURN_MIN  minutes one turn may run before it is stopped
//   RELAY_CANVAS_IDLE_STOP_MIN minutes without a turn before the omp process stops (it resumes the same session on the next note)

import { MODELS, type ModelKey } from "@relay/canvas-live/shared";

export type CanvasEffort = "low" | "medium";

export interface CanvasAgentConfig {
  readonly model: ModelKey;
  readonly effort: CanvasEffort;
  readonly maxRequests: number;
  readonly maxTokens: number;
  readonly maxTurnMs: number;
  readonly idleStopMs: number;
}

export const DEFAULT_CANVAS_AGENT: CanvasAgentConfig = {
  model: "opus",
  effort: "low",
  // Generous token cap, no dollar thinking (Isaac, 2026-11-05: mind token usage, not cost; it runs
  // on his subscription). maxTurnMs and idleStopMs still guard a single stuck turn and an idle room.
  maxRequests: 1_000,
  maxTokens: 40_000_000,
  maxTurnMs: 10 * 60_000,
  idleStopMs: 10 * 60_000,
};

/**
 * The tools the canvas self gets besides its board tools: files, shell, search, edits, subagents,
 * web research and the browser. `eval` (arbitrary code with no path checks) and the desktop tools
 * stay out; the guard (guard.ts) refuses them anyway, for subagents too.
 */
export const CANVAS_TOOLS = ["read", "bash", "edit", "write", "glob", "grep", "task", "wait", "todo", "web_search", "browse"] as const;

function positive(raw: string | undefined, name: string, fallback: number, scale = 1): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, not "${raw}"`);
  return Math.round(n * scale);
}

/** The config from the environment over the defaults. Throws a readable error for a bad value. */
export function canvasAgentConfig(env: Record<string, string | undefined> = process.env): CanvasAgentConfig {
  const model = env["RELAY_CANVAS_MODEL"]?.trim() ?? "";
  const pickedModel = model === "" ? DEFAULT_CANVAS_AGENT.model : model;
  if (!(pickedModel in MODELS)) throw new Error(`RELAY_CANVAS_MODEL must be one of ${Object.keys(MODELS).join(", ")}, not "${pickedModel}"`);
  const rawEffort = env["RELAY_CANVAS_EFFORT"]?.trim() ?? "";
  const effort = rawEffort === "" ? DEFAULT_CANVAS_AGENT.effort : rawEffort;
  if (effort !== "low" && effort !== "medium") throw new Error(`RELAY_CANVAS_EFFORT must be low or medium, not "${effort}"`);
  return {
    model: pickedModel as ModelKey,
    effort,
    maxRequests: positive(env["RELAY_CANVAS_MAX_TURNS"], "RELAY_CANVAS_MAX_TURNS", DEFAULT_CANVAS_AGENT.maxRequests),
    maxTokens: positive(env["RELAY_CANVAS_MAX_TOKENS"], "RELAY_CANVAS_MAX_TOKENS", DEFAULT_CANVAS_AGENT.maxTokens),
    maxTurnMs: positive(env["RELAY_CANVAS_MAX_TURN_MIN"], "RELAY_CANVAS_MAX_TURN_MIN", DEFAULT_CANVAS_AGENT.maxTurnMs, 60_000),
    idleStopMs: positive(env["RELAY_CANVAS_IDLE_STOP_MIN"], "RELAY_CANVAS_IDLE_STOP_MIN", DEFAULT_CANVAS_AGENT.idleStopMs, 60_000),
  };
}

export interface MindArgsInput {
  readonly omp: string;
  /** `--profile`; null runs on omp's default sign-ins. */
  readonly profile: string | null;
  /** `--config` overlays after the user's own config, in order. */
  readonly configs: readonly string[];
  /** The owner's omp config (`~/.omp/agent/config.yml`). */
  readonly baseConfig: string;
  /** Where the agent works: the agent home, so its rules, skills and project tools load as in the chat. */
  readonly cwd: string;
  /** The room's session directory (its transcript survives an idle stop). */
  readonly sessionDir: string;
  /** The guard extension (guard.ts) written for this room. */
  readonly guard: string;
  readonly model: ModelKey;
  readonly effort: CanvasEffort;
  /** The canvas identity, chat and memory (agent.ts), after omp's own system prompt. */
  readonly appendSystemPrompt: string;
}

/**
 * The omp command line of a room's canvas self: RPC, a saved session in the room's own directory,
 * the normal tools, the guard as its only extension (no relay-bridge: it is not a Relay chat of
 * its own), no session title round trip.
 */
export function mindArgs(input: MindArgsInput): string[] {
  return [
    input.omp,
    ...(input.profile === null ? [] : ["--profile", input.profile]),
    ...[input.baseConfig, ...input.configs].flatMap((config) => ["--config", config]),
    "--mode", "rpc", "--no-ui", "--no-title", "--no-extensions",
    "--extension", input.guard,
    "--tools", CANVAS_TOOLS.join(","),
    "--cwd", input.cwd,
    "--session-dir", input.sessionDir,
    "--model", MODELS[input.model].id,
    "--thinking", input.effort,
    "--append-system-prompt", input.appendSystemPrompt,
  ];
}
