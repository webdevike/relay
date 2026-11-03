import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Board,
  BoardOp,
  checkLiveOpenUI,
  checkQueryArgs,
  ClientMessage,
  createOpenUIRuntime,
  QUERY_TOOLS,
  renderLiveOpenUI,
  ServerMessage,
  type OpenUIQueryClient,
} from "../src";

/** The proof dashboard card: work items by workspace and jobs' last runs, refreshing every 30 s. */
const LIVE = `root = Card([stats, byWs, jobList, refresh], "Live work")
items = Query("work_items", {}, {total: 0, byWorkspace: [{name: "Loading", count: 0}], items: [], asOf: "-"}, 30)
jobs = Query("jobs", {}, {total: 0, failing: 0, jobs: [], asOf: "-"}, 30)
stats = Stack([Stat("Open items", "" + items.total), Stat("Jobs failing", "" + jobs.failing)], "horizontal")
byWs = Rows(@Each(items.byWorkspace, "w", Row(w.name, "" + w.count)))
jobList = Text("Jobs as of " + jobs.asOf, "caption")
refresh = Button("Refresh", Action([@Run(items), @Run(jobs)]))`;

function fakeClient(answers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const client: OpenUIQueryClient = {
    run: (tool, args) => {
      calls.push({ tool, args });
      const answer = answers[tool];
      return answer ? Promise.resolve(answer(args)) : Promise.reject(new Error("no such tool"));
    },
  };
  return { client, calls };
}

/** Lets the runner's fetch (queued as microtasks) reach the fake client and land its answer. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** The button among the root's children, read through the runtime's own tree. */
function refreshAction(node: unknown): string | undefined {
  if (typeof node !== "object" || node === null || !("children" in node) || !Array.isArray(node.children)) return undefined;
  for (const child of node.children as unknown[])
    if (typeof child === "object" && child !== null && "action" in child && typeof child.action === "string") return child.action;
  return undefined;
}

describe("createOpenUIRuntime with a query client", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows defaults, swaps in data once subscribed, refreshes on the interval and on @Run", async () => {
    let total = 3;
    const { client, calls } = fakeClient({
      work_items: () => ({ total, byWorkspace: [{ name: "Relay", count: total }], items: [], asOf: "12:00:00" }),
      jobs: () => ({ total: 2, failing: 1, jobs: [], asOf: "12:00:01" }),
    });
    const runtime = createOpenUIRuntime(LIVE, { query: client });
    expect(runtime.snapshot().errors).toEqual([]);
    expect(runtime.snapshot().node).toMatchObject({ children: [{ children: [{ value: "0" }, { value: "0" }] }, {}, { text: "Jobs as of -" }, {}] });
    // Nothing fetches until someone renders it.
    expect(calls).toEqual([]);
    const seen = vi.fn();
    const off = runtime.subscribe(seen);
    await flush();
    expect(calls.map((c) => c.tool)).toEqual(["work_items", "jobs"]);
    expect(seen).toHaveBeenCalled();
    expect(runtime.snapshot().node).toMatchObject({
      children: [{ children: [{ value: "3" }, { value: "1" }] }, { rows: [{ label: "Relay", value: "3" }] }, { text: "Jobs as of 12:00:01" }, {}],
    });

    total = 5;
    vi.advanceTimersByTime(30_000);
    await flush();
    expect(calls).toHaveLength(4);
    await flush();
    expect(runtime.snapshot().node).toMatchObject({ children: [{ children: [{ value: "5" }, {}] }, {}, {}, {}] });

    expect(refreshAction(runtime.snapshot().node)).toBe("refresh");
    expect(runtime.dispatch("refresh")).toEqual({});
    await flush();
    expect(calls).toHaveLength(6);

    // Off screen: no more refreshing.
    off();
    vi.advanceTimersByTime(120_000);
    expect(calls).toHaveLength(6);
  });

  it("refetches when the args a $variable feeds change, and keeps the last data on a failed fetch", async () => {
    let fail = false;
    const { client, calls } = fakeClient({
      work_items: (args) => {
        if (fail) throw new Error("ledger unreadable");
        return { total: args["workspace"] === "relay" ? 8 : 70 };
      },
    });
    const runtime = createOpenUIRuntime(
      `root = Stack([Input("Workspace", null, null, null, $ws), Text("Items: " + items.total)])
$ws = "all"
items = Query("work_items", $ws == "all" ? {} : {workspace: $ws}, {total: 0})`,
      { query: client },
    );
    runtime.subscribe(() => undefined);
    await flush();
    expect(runtime.snapshot().node).toMatchObject({ children: [{}, { text: "Items: 70" }] });
    runtime.setInput("root/children/0", "relay");
    await flush();
    expect(calls.at(-1)).toEqual({ tool: "work_items", args: { workspace: "relay" } });
    await flush();
    expect(runtime.snapshot().node).toMatchObject({ children: [{}, { text: "Items: 8" }] });
    fail = true;
    runtime.setInput("root/children/0", "eva");
    await flush();
    expect(runtime.snapshot().node).toMatchObject({ children: [{}, { text: "Items: 8" }] });
    expect(runtime.snapshot().errors).toEqual([
      { code: "query-error", message: "work_items: ledger unreadable", statementId: "items", severity: "warning" },
    ]);
  });

  it("without a client a Query shows its defaults and says why", () => {
    const runtime = createOpenUIRuntime('root = Text("n=" + q.n)\nq = Query("jobs", {}, {n: 0}, 30)');
    runtime.subscribe(() => undefined);
    expect(runtime.snapshot().node).toEqual({ widget: "text", text: "n=0" });
    expect(runtime.snapshot().errors.map((e) => [e.code, e.severity])).toEqual([["query-error", "warning"]]);
  });
});

describe("checkLiveOpenUI", () => {
  it("accepts allowlisted tools with valid args and refresh", () => {
    const check = checkLiveOpenUI(LIVE);
    expect(check.errors).toEqual([]);
    expect(check.queries.map((q) => [q.id, q.tool, q.refreshSec])).toEqual([
      ["items", "work_items", 30],
      ["jobs", "jobs", 30],
    ]);
  });

  it("refuses unknown tools, bad args, out-of-range refresh, Mutation and parse errors", () => {
    const codes = (text: string) => checkLiveOpenUI(text).errors.map((e) => e.message);
    expect(codes('root = Text("x")\nq = Query("shell", {cmd: "rm -rf /"}, {})')[0]).toMatch(/unknown query tool "shell"/);
    expect(codes('root = Text("x")\nq = Query("work_items", {path: "/etc"}, {})')[0]).toMatch(/work_items args: .*path/);
    expect(codes('root = Text("x")\nq = Query("github_prs", {repo: "a/b; curl x"}, {})')[0]).toMatch(/github_prs args: repo/);
    expect(codes('root = Text("x")\nq = Query("linear_issues", {limit: 500}, {})')[0]).toMatch(/limit/);
    expect(codes('root = Text("x")\nq = Query("jobs", {}, {}, 2)')[0]).toMatch(/refresh is 2s/);
    expect(codes('root = Text("x")\nq = Query(42, {}, {})')[0]).toMatch(/tool name string/);
    expect(codes('root = Text("x")\nm = Mutation("jobs", {})')[0]).toMatch(/Mutation/);
    expect(codes("root = Card([")).toContain("the program ends mid-statement (unclosed string, bracket or call)");
    expect(codes("root = Foo(1)").length).toBeGreaterThan(0);
  });
});

describe("renderLiveOpenUI", () => {
  it("renders with the data the queries return, falling back to defaults (with a warning) on failure", async () => {
    const render = await renderLiveOpenUI(LIVE, (tool) =>
      tool === "jobs" ? Promise.reject(new Error("down")) : Promise.resolve({ total: 4, byWorkspace: [{ name: "GoodOps", count: 4 }], asOf: "9:00:00" }),
    );
    expect(render.errors).toEqual([]);
    expect(render.node).toMatchObject({ widget: "card", children: [{ children: [{ value: "4" }, { value: "0" }] }, { rows: [{ label: "GoodOps", value: "4" }] }, {}, {}] });
    expect(render.warnings.map((w) => w.message)).toEqual(["jobs: down"]);
  });

  it("refuses a source that does not check", async () => {
    const render = await renderLiveOpenUI('root = Text("x")\nq = Query("nope", {}, {})', () => Promise.resolve({}));
    expect(render.node).toBeNull();
    expect(render.errors[0]?.code).toBe("query-error");
  });
});

describe("query contract", () => {
  it("checks args against each tool's strict schema and fills defaults", () => {
    expect(checkQueryArgs("github_prs", {})).toEqual({ ok: true, tool: "github_prs", args: { filter: "authored", state: "open", limit: 20 } });
    expect(checkQueryArgs("relay_sessions", { kind: "job" })).toMatchObject({ ok: true, args: { kind: "job", limit: 30 } });
    expect(checkQueryArgs("jobs", { name: "../secrets" })).toMatchObject({ ok: false });
    expect(checkQueryArgs("toString", {})).toMatchObject({ ok: false });
  });

  it("result schemas strip fields a tool did not list", () => {
    const parsed = QUERY_TOOLS.jobs.result.parse({ asOf: "1", at: 1, total: 1, failing: 0, jobs: [{ name: "a", enabled: true, kind: "script", env: "SECRET" }], token: "x" });
    expect(parsed).toEqual({ asOf: "1", at: 1, total: 1, failing: 0, jobs: [{ name: "a", enabled: true, kind: "script" }] });
  });

  it("has query.req / query.res frames and welcome features", () => {
    expect(ClientMessage.safeParse({ t: "query.req", rid: "r1", tool: "jobs", args: {} }).success).toBe(true);
    expect(ServerMessage.safeParse({ t: "query.res", rid: "r1", ok: true, data: { x: 1 } }).success).toBe(true);
    const welcome = ServerMessage.parse({ t: "welcome", state: { mac: { name: "m", version: "1", accessibilityGranted: true, agentsAvailable: true }, agents: { rev: 0, sessions: [] } }, features: ["query"] });
    expect(welcome).toMatchObject({ features: ["query"] });
  });

  it("boards carry an openui source next to its static spec; ops may give either", () => {
    const board = Board.parse({ slug: "ops", title: "Ops", widgets: [{ id: "live", spec: { widget: "divider" }, openui: LIVE }], updatedAt: new Date().toISOString() });
    expect(board.widgets[0]).toMatchObject({ id: "live", span: 12, openui: LIVE });
    expect(BoardOp.safeParse({ op: "upsert", id: "live", openui: LIVE }).success).toBe(true);
    expect(BoardOp.safeParse({ op: "upsert", id: "live", openui: "" }).success).toBe(false);
  });
});
