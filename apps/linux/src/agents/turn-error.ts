// A failed omp turn as a transcript row. Shared by the relay-bridge omp extension (which reports a
// turn omp refused before it started, e.g. "No API key found for anthropic", and a turn the model
// ended with an error) and by the host's transcript reader. Runs under omp's bun with no
// node_modules (see transcript.ts): node built-ins only, no zod, no @relay/protocol.

/** Why a turn failed (protocol `TurnFailureKind`); "exit" is the host's own, when omp stops mid-turn. */
export type TurnFailureKind = "auth" | "rate_limit" | "model" | "exit";

/** What a failed-turn row carries (protocol `TurnError`). */
export interface TurnErrorRow {
  kind: TurnFailureKind;
  /** The provider of the model the turn ran on (omp's provider id, e.g. "anthropic"). */
  provider?: string;
  /** The start of the message that never reached the model, when the turn failed before it started. */
  prompt?: string;
}

/**
 * omp custom entry type the bridge appends (`pi.appendEntry`, never sent to the model) when a turn
 * fails before it starts, so the failure outlives the bridge: omp writes no message for such a turn.
 * Its data is `{ text, kind, provider?, prompt? }`.
 */
export const TURN_ERROR_TYPE = "relay-turn-error";

/** Characters of the lost message a failed-turn row quotes. */
export const MAX_PROMPT_EXCERPT = 120;
/** Characters of omp's error a row keeps. */
export const MAX_ERROR_TEXT = 400;

const AUTH =
  /no api key|\bapi[ _-]?key\b|no model selected|\boauth\b|invalid_grant|unauthori[sz]ed|authentication|\b401\b|\b403\b|forbidden|\bcredentials?\b|\/login\b|refresh token/i;
const RATE = /\b429\b|rate[ _-]?limit|usage limit|quota|limit reached|too many requests/i;

/** The kind of a failure from omp's error text: a sign-in problem, a rate or usage limit, else a model error. */
export function turnFailureKind(error: string): Exclude<TurnFailureKind, "exit"> {
  if (AUTH.test(error)) return "auth";
  if (RATE.test(error)) return "rate_limit";
  return "model";
}

/** The provider omp names in "No API key found for <provider>" (quoted or not); null when it names none. */
export function providerInError(error: string): string | null {
  const match = /no api key found for "?([A-Za-z0-9._-]+?)"?(?:[.\s]|$)/i.exec(error);
  return match?.[1] ?? null;
}

/** `text` on one line, cut to `max` characters with an ellipsis. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The failed-turn row data for omp error `error`: its kind, the provider (named in the error, else `provider`) and the lost message's start. */
export function turnErrorOf(error: string, provider?: string, prompt?: string): TurnErrorRow {
  const row: TurnErrorRow = { kind: turnFailureKind(error) };
  const named = providerInError(error) ?? provider;
  if (named !== undefined && named.length > 0) row.provider = named;
  const lost = prompt === undefined ? "" : oneLine(prompt, MAX_PROMPT_EXCERPT);
  if (lost.length > 0) row.prompt = lost;
  return row;
}

/** The text and row data of a `relay-turn-error` entry's `data`; null for data this build cannot read. */
export function turnErrorEntryOf(data: unknown): { text: string; error: TurnErrorRow } | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const text = d["text"];
  const kind = d["kind"];
  if (typeof text !== "string" || text.length === 0) return null;
  if (kind !== "auth" && kind !== "rate_limit" && kind !== "model" && kind !== "exit") return null;
  const error: TurnErrorRow = { kind };
  if (typeof d["provider"] === "string" && d["provider"].length > 0) error.provider = d["provider"];
  if (typeof d["prompt"] === "string" && d["prompt"].length > 0) error.prompt = d["prompt"];
  return { text: oneLine(text, MAX_ERROR_TEXT), error };
}
