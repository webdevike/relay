// omp's goal mode as the phone sees it, the way EvaOS reads it (apps/evaos/src/chat.rs, `GoalInfo`,
// `goal_command`). Used by the relay-bridge omp extension, which imports it by relative path under
// omp's bun, so this file may only use node built-ins (no zod, no @relay/protocol).
//
// A goal is reported while it is active or paused; once it is met ("complete") or dropped, or the
// mode leaves goal ("none"), the session has none. Live sessions learn of changes from omp's
// `goal_updated` event; a session's starting goal is the last `mode_change` on its branch.

/** Mirrors `AgentGoal` in @relay/protocol. */
export interface Goal {
  objective: string;
  paused: boolean;
  tokensUsed: number;
}

/** omp's goal record (`goal_updated.goal`, `mode_change.data.goal`) as a phone goal; undefined unless active or paused. */
export function goalOf(value: unknown): Goal | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const goal = value as { status?: unknown; objective?: unknown; tokensUsed?: unknown };
  if (goal.status !== "active" && goal.status !== "paused") return undefined;
  if (typeof goal.objective !== "string" || goal.objective.trim().length === 0) return undefined;
  const tokens = typeof goal.tokensUsed === "number" && Number.isFinite(goal.tokensUsed) ? Math.max(0, Math.floor(goal.tokensUsed)) : 0;
  return { objective: goal.objective, paused: goal.status === "paused", tokensUsed: tokens };
}

/**
 * The goal a session's branch leaves it with: the last `mode_change` decides. One carrying a goal
 * record sets it (or clears it, once met or dropped); mode "none" clears it; other modes (plan,
 * vibe) leave it alone, as EvaOS does.
 */
export function goalFromEntries(entries: Iterable<unknown>): Goal | undefined {
  let goal: Goal | undefined;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const change = entry as { type?: unknown; mode?: unknown; data?: { goal?: unknown } | null };
    if (change.type !== "mode_change") continue;
    const record = change.data?.goal;
    if (typeof record === "object" && record !== null) goal = goalOf(record);
    else if (change.mode === "none") goal = undefined;
  }
  return goal;
}

/** Whether two reports describe the same goal, so an unchanged one is not re-sent. */
export function sameGoal(a: Goal | undefined, b: Goal | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.objective === b.objective && a.paused === b.paused && a.tokensUsed === b.tokensUsed;
}

/**
 * A `/goal` sent from the phone, rewritten into the form omp's terminal runs without asking the
 * terminal anything back: the phone can't see omp's goal menu or fill its objective editor. Bare
 * `/goal`, `status`, `get` and an objectiveless `set` read the goal (`/goal show`); `clear` drops
 * it; `/goal <objective>` sets it (replacing an active one), as EvaOS maps them. Anything that is
 * not `/goal` comes back null. `/goal drop` still opens omp's confirm, which the bridge answers.
 */
export function phoneGoalCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/goal")) return null;
  const rest = trimmed.slice("/goal".length);
  if (rest.length > 0 && !/^\s/.test(rest)) return null;
  const args = rest.trim();
  const space = args.search(/\s/);
  const word = space === -1 ? args : args.slice(0, space);
  const tail = space === -1 ? "" : args.slice(space).trim();
  switch (word) {
    case "":
    case "status":
    case "get":
    case "show":
      if (tail === "") return "/goal show";
      break;
    case "pause":
    case "resume":
    case "drop":
      if (tail === "") return `/goal ${word}`;
      break;
    case "clear":
      if (tail === "") return "/goal drop";
      break;
    case "set":
    case "create":
      return tail === "" ? "/goal show" : `/goal set ${tail}`;
    case "budget":
      return `/goal budget ${tail}`.trimEnd();
  }
  return `/goal set ${args}`;
}
