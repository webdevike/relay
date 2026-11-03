/**
 * The write-time check for live OpenUI sources (dashboard widgets, canvas `ui` nodes): the program
 * parses with no error, runs no Mutation, and every Query names an allowlisted tool with valid args
 * and a refresh interval in range. `renderLiveOpenUI` then evaluates it against real query data
 * into the static tree older clients draw. Host side only (it needs the query catalog's zod schemas).
 */
import { checkQueryArgs, QUERY_MAX_REFRESH_SEC, QUERY_MIN_REFRESH_SEC } from "../query";
import type { WidgetSpec } from "../widget";
import { buildTree, compileProgram, type OpenUIError } from "./parse";
import { queryCalls, type QueryCall } from "./queries";

/** Longest live source a board widget or canvas node holds. */
export const MAX_LIVE_OPENUI = 20_000;

export interface LiveOpenUICheck {
  /** What refuses the source; empty when it may be written. */
  errors: OpenUIError[];
  /** Its Query statements, evaluated against the declared `$variable` defaults. */
  queries: QueryCall[];
}

/** Checks a live source; never throws. */
export function checkLiveOpenUI(text: string): LiveOpenUICheck {
  if (text.length > MAX_LIVE_OPENUI)
    return { errors: [{ code: "parse-exception", message: `source is ${String(text.length)} chars, at most ${String(MAX_LIVE_OPENUI)}` }], queries: [] };
  const program = compileProgram(text, false);
  const errors = program.errors.filter((e) => e.severity !== "warning");
  const defaults = program.result?.stateDeclarations ?? {};
  const queries = queryCalls(program.result, (name) => defaults[name] ?? null);
  for (const call of queries) {
    const at = { statementId: call.id, component: "Query" };
    if (call.tool === null) {
      errors.push({ code: "query-error", message: "Query's first argument must be a tool name string", ...at });
      continue;
    }
    const args = checkQueryArgs(call.tool, call.args);
    if (!args.ok) errors.push({ code: "query-error", message: args.error, ...at });
    if (call.refreshSec !== null && (call.refreshSec < QUERY_MIN_REFRESH_SEC || call.refreshSec > QUERY_MAX_REFRESH_SEC))
      errors.push({
        code: "query-error",
        message: `refresh is ${String(call.refreshSec)}s; give ${String(QUERY_MIN_REFRESH_SEC)} to ${String(QUERY_MAX_REFRESH_SEC)} seconds, or leave it out to fetch once`,
        ...at,
      });
  }
  return { errors, queries };
}

export interface LiveOpenUIRender {
  /** The tree with the data the queries returned (their defaults where one failed); null with errors. */
  node: WidgetSpec | null;
  errors: OpenUIError[];
  /** Fetches that failed and widgets the data made invalid (dropped from the tree). */
  warnings: OpenUIError[];
}

/** Checks the source, runs its queries through `run` and evaluates it into a static tree. */
export async function renderLiveOpenUI(text: string, run: (tool: string, args: Record<string, unknown>) => Promise<unknown>): Promise<LiveOpenUIRender> {
  const check = checkLiveOpenUI(text);
  if (check.errors.length > 0) return { node: null, errors: check.errors, warnings: [] };
  const warnings: OpenUIError[] = [];
  const data = new Map<string, unknown>();
  await Promise.all(
    check.queries.map(async (call) => {
      try {
        data.set(call.id, await run(call.tool ?? "", call.args));
      } catch (error) {
        data.set(call.id, call.defaults);
        const message = error instanceof Error ? error.message : String(error);
        warnings.push({ code: "query-error", message: `${call.tool ?? "Query"}: ${message}`, statementId: call.id, severity: "warning" });
      }
    }),
  );
  const program = compileProgram(text, false);
  const defaults = program.result?.stateDeclarations ?? {};
  const built = buildTree(program, (name) => defaults[name] ?? null, (name) => data.get(name) ?? null);
  for (const e of built.errors) if (!program.errors.includes(e)) warnings.push({ ...e, severity: "warning" });
  if (built.node === null)
    return { node: null, errors: [{ code: "no-root", message: "the root does not render with the data its queries returned" }], warnings };
  return { node: built.node, errors: [], warnings };
}
