// Settings > Usage by agent: who ran each omp session, from the skills usage index's attribution
// (skills/usage.ts `runners`, the same records the Skills page counts loads with), folded into the
// rows Isaac reads: an assistant (its own thread, sessions it started, jobs that report to it), Eren
// and Elysia, Helpers (every subagent), and Other (sessions nothing claims, such as a terminal omp).

import type { Runner } from "../skills/usage";

const LABEL: Record<string, string> = { eren: "Eren", elysia: "Elysia", "claude-code": "Claude Code" };
const HELPERS = { agent: "helpers", label: "Helpers" } as const;
const OTHER = { agent: "other", label: "Other" } as const;

function named(id: string): { agent: string; label: string } {
  return { agent: id, label: LABEL[id] ?? `${id.charAt(0).toUpperCase()}${id.slice(1)}` };
}

/** The by-agent row a session's runner counts toward. */
export function agentRow(runner: Runner | null): { agent: string; label: string } {
  if (runner === null) return OTHER;
  switch (runner.kind) {
    case "assistant":
    case "background":
    case "claude":
      return named(runner.agent);
    case "session":
      return runner.owner === null ? { agent: "sessions", label: "Agent sessions" } : named(runner.owner);
    case "job":
      return runner.owner === null ? { agent: "jobs", label: "Jobs" } : named(runner.owner);
    case "subagent":
      return HELPERS;
    case "other":
      return OTHER;
  }
}

