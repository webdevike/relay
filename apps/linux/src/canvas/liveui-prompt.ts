// The canvas self's lesson on live `ui` nodes: the `@add_ui` line, when to reach for it, the host's
// query tools with their exact args and result fields (read off the zod schemas in
// packages/protocol/src/query.ts, so the prompt cannot drift from what the host answers), the
// refresh range and example programs. The examples are checked by test/canvas-agent.test.ts.

import { z } from "zod";
import { QUERY_MAX_REFRESH_SEC, QUERY_MIN_REFRESH_SEC, QUERY_TOOLS, QUERY_TOOL_NAMES } from "@relay/protocol";

/** Field names of an object schema, with the element fields of its array members: `jobs [{name, ...}]`. */
function fieldsOf(schema: z.ZodObject<z.ZodRawShape>): string {
  return Object.entries(schema.shape)
    .map(([key, value]) => {
      const element: unknown = value instanceof z.ZodArray ? value.element : null;
      return element instanceof z.ZodObject ? `${key} [{${Object.keys(element.shape as Record<string, unknown>).join(", ")}}]` : key;
    })
    .join(", ");
}

function toolLines(): string {
  return QUERY_TOOL_NAMES.map((name) => {
    const tool = QUERY_TOOLS[name];
    const args = Object.keys(tool.args.shape).join(", ");
    return `- ${name}: ${tool.description}\n  args: {${args}} (all optional, no other keys)\n  result fields: ${fieldsOf(tool.result)}`;
  }).join("\n");
}

/** Example programs for the prompt; each is a complete `@add_ui` body (source only). */
export const LIVE_UI_EXAMPLES: readonly { id: string; title: string; width: number; source: string }[] = [
  {
    id: "live-jobs",
    title: "Jobs last run",
    width: 480,
    source: `root = Card([head, table, asOf, again], "Jobs last run")
jobs = Query("jobs", {}, {total: 0, failing: 0, jobs: [{name: "Loading", lastRunAt: 0, lastRunAgo: "-", lastResult: "-"}], asOf: "-"}, 30)
head = Stack([Stat("Jobs", "" + jobs.total), Stat("Failing", "" + jobs.failing)], "horizontal")
table = Table(["Job", "Last run", Column("Result", "right")], @Each(@Sort(jobs.jobs, "lastRunAt", "desc"), "j", [j.name, j.lastRunAgo == null ? "never" : j.lastRunAgo, Cell(j.lastResult == null ? "unknown" : j.lastResult, j.lastResult == "failed" ? "danger" : (j.lastResult == "ok" ? "ok" : "muted"))]))
asOf = Text("As of " + jobs.asOf + ", refreshes every 30 s", "caption")
again = Button("Refresh now", @Run(jobs), null, "subtle")`,
  },
  {
    id: "live-work",
    title: "Work items by workspace",
    width: 420,
    source: `root = Card([head, chart, asOf], "Work items by workspace")
items = Query("work_items", {}, {total: 0, byWorkspace: [{name: "Loading", count: 0}], items: [], asOf: "-"}, 30)
head = Stack([Stat("Open items", "" + items.total), Stat("Workspaces", "" + @Count(items.byWorkspace))], "horizontal")
chart = Chart("bar", [Series(@Each(items.byWorkspace, "w", w.count), "items")], @Each(items.byWorkspace, "w", w.name))
asOf = Text("As of " + items.asOf + ", refreshes every 30 s", "caption")`,
  },
  {
    id: "live-prs",
    title: "My open PRs",
    width: 480,
    source: `root = Card([head, table, asOf], "My open PRs")
prs = Query("github_prs", {filter: "authored", state: "open", limit: 10}, {total: 0, prs: [{repo: "-", number: 0, title: "Loading", updatedAgo: "-", draft: false}], asOf: "-"}, 60)
head = Stat("Open PRs", "" + prs.total)
table = Table(["PR", "Repo", Column("Updated", "right")], @Each(prs.prs, "p", [p.title, p.repo, p.updatedAgo]))
asOf = Text("As of " + prs.asOf + ", refreshes every 60 s", "caption")`,
  },
];

/** The live-widget section of the canvas self's system prompt. */
export function liveUiPrompt(): string {
  const examples = LIVE_UI_EXAMPLES.map((e, i) => `Example ${String(i + 1)}:\n@add_ui ${e.id} ${String(i * 520)} 0 ${String(e.width)}\n${e.title}\n${e.source}\n@end`).join("\n\n");
  return `Live widgets (@add_ui):
A "ui" node is a live widget written in OpenUI Lang that reads real data from Relay and refreshes itself. Syntax: @add_ui <newId> <x> <y> <width> [height], then the title on the first line, then the OpenUI program (one statement per line), then @end. @set_text <uiId> body with a new program replaces it. Use @add_ui for ANY request for live data, a widget, a dashboard, a chart, a status board, "what's running", PRs, issues, jobs or work items: one @add_ui per widget, a few side by side for a dashboard (about 480 apart, same y). Never put OpenUI code (root = ..., Query(...)) in a note, topic or suggestion: notes show it as raw text. Never invent data, and never type numbers you did not read; the widget reads them itself.

A program has a root statement and a Query per data source:
  name = Query("tool", {args}, defaults, refreshSec)
Components: Card([children], "Title"), Stack([children], "horizontal"), Stat("Label", "" + value), Rows([Row("a", "b")]), Table(["Col", Column("Right", "right")], rows), Cell("text", "ok"|"danger"|"warn"|"muted"), Chart("bar", [Series(values, "name")], labels), Text("x", "caption"), Badge("x", "accent"), Button("Refresh", @Run(name), null, "subtle"). Read data with member access and @Each(list, "x", expr), @Count, @Sort(list, "field", "desc"), @Filter. Optional fields can be null: j.lastRunAgo == null ? "never" : j.lastRunAgo. Give defaults the result's shape with one placeholder row.

The ONLY tools are these ${String(QUERY_TOOL_NAMES.length)} (any other name is refused): ${QUERY_TOOL_NAMES.join(", ")}.
${toolLines()}
Every result also has asOf ("HH:MM:SS") and at (epoch ms). Args are strict: an unknown key is refused. refreshSec is ${String(QUERY_MIN_REFRESH_SEC)} to ${String(QUERY_MAX_REFRESH_SEC)} seconds; leave it out to fetch once. A program that does not check is skipped and you are told why ("Did not run: ..."); fix it and send it again.

${examples}`;
}
