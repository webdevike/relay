import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUERY_TOOLS, type AgentSession } from "@relay/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FileBoardStore } from "../src/boards/store";
import { handleQueryRequest } from "../src/query/http";
import { liveRender, liveRefusal } from "../src/query/openui";
import { QueryService } from "../src/query/service";
import type { GoodOpsSql } from "../src/query/goodops";
import { queryTools, type QueryToolDeps, type QueryTools } from "../src/query/tools";
import type { ToolRun } from "../src/reviews/exec";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-11-03T17:00:00Z");

/** An Eva root with two ledgers (and a non-ledger next to them), a workspace file and two jobs. */
function evaRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "relay-query-"));
  dirs.push(root);
  mkdirSync(join(root, "work", "items"), { recursive: true });
  writeFileSync(join(root, "work", "items", "ENG-1.md"), "---\nkey: ENG-1\ntitle: Sort icon\nworkspace: ecardsystems\nstage: 9 PR\nmove: steve\nupdated: 2026-11-02\n---\n\n## Log\n");
  writeFileSync(join(root, "work", "items", "ENG-2.md"), "---\nkey: ENG-2\ntitle: Access matrix\nworkspace: ecardsystems\nstage: 7 Verify\nmove: isaac\nupdated: 2026-10-23\n---\n");
  writeFileSync(join(root, "work", "items", "relay-live.md"), "---\nkey: relay-live\ntitle: Live widgets\nworkspace: relay\nstage: build\nmove: eva\n---\n");
  writeFileSync(join(root, "work", "items", "ENG-1.pr-body.md"), "---\nkey: ENG-1\ntitle: not a ledger\n---\n");
  mkdirSync(join(root, "workspaces"));
  writeFileSync(join(root, "workspaces", "ecardsystems.md"), "# eCard Systems\n\nIsaac's employer.\n");
  for (const [name, fm] of [
    ["heartbeat", "every: 30m\nenabled: true\nscript: bun $JOB/scripts/sweep.ts"],
    ["nightly", "every: 1d\nenabled: false"],
  ] as const) {
    mkdirSync(join(root, "jobs", name), { recursive: true });
    writeFileSync(join(root, "jobs", name, "job.md"), `---\n${fm}\n---\n# ${name}\n`);
  }
  mkdirSync(join(root, "jobs", ".runs", "heartbeat"), { recursive: true });
  writeFileSync(join(root, "jobs", ".runs", "heartbeat", "last-run"), `${String(NOW - 5 * 60_000)}\n`);
  writeFileSync(join(root, "jobs", ".runs", "heartbeat", "job.log"), "[2026-11-03T16:50:00.000Z] script failed (1): boom\n[2026-11-03T16:55:00.000Z] script ok: heartbeat[nova]: 2 new\nsources: slack=0\n");
  mkdirSync(join(root, "jobs", ".runs", "nightly", "2026-11-02T030000"), { recursive: true });
  writeFileSync(join(root, "jobs", ".runs", "nightly", "last-run"), `${String(NOW - 2 * 86_400_000)}\n`);
  writeFileSync(join(root, "jobs", ".runs", "nightly", "2026-11-02T030000", "status.json"), JSON.stringify({ state: "timeout", sessionFile: "/secret/path.jsonl" }));
  return root;
}

const session = (over: Partial<AgentSession>): AgentSession => ({
  id: "s1",
  provider: "omp",
  title: "relay",
  projectPath: "/Users/ike/Eva",
  status: "working",
  lastActivity: "Editing store.ts",
  lastActivityAt: NOW - 60_000,
  canRespond: true,
  ...over,
});

function deps(over: Partial<QueryToolDeps> = {}): QueryToolDeps {
  return {
    evaRoot: evaRoot(),
    run: () => Promise.reject(new Error("no gh in this test")),
    gh: "gh",
    linearKey: () => null,
    fetch: () => Promise.reject(new Error("no network in this test")),
    sessions: () => [session({}), session({ id: "s2", status: "ended" }), session({ id: "s3", status: "waiting", kind: "job" })],
    assistants: () => Promise.resolve([{ id: "nova", title: "Nova", status: "idle", lastReply: { text: "Done.", at: NOW } }]),
    now: () => NOW,
    goodops: () => null,
    ...over,
  };
}

describe("query tools", () => {
  it("work_items reads only ledgers, names workspaces from their files and counts them", async () => {
    const tools = queryTools(deps());
    const all = (await tools.work_items({ limit: 50 })) as { total: number; byWorkspace: unknown; items: { key: string }[] };
    expect(all.total).toBe(3);
    expect(all.byWorkspace).toEqual([
      { name: "eCard Systems", count: 2 },
      { name: "relay", count: 1 },
    ]);
    expect(all.items.map((i) => i.key)).toEqual(["ENG-1", "ENG-2", "relay-live"]);
    const mine = (await tools.work_items({ move: "isaac", limit: 50 })) as { items: { key: string }[] };
    expect(mine.items.map((i) => i.key)).toEqual(["ENG-2"]);
  });

  it("jobs reports schedule, last run, verdict and last line, newest first", async () => {
    const result = await queryTools(deps()).jobs({});
    expect(result).toMatchObject({
      total: 2,
      failing: 1,
      jobs: [
        { name: "heartbeat", kind: "script", every: "30m", enabled: true, lastRunAgo: "5m ago", lastResult: "ok", lastLine: "sources: slack=0" },
        { name: "nightly", kind: "session", enabled: false, lastRunAgo: "2d ago", lastResult: "failed" },
      ],
    });
  });

  it("github_prs passes only fixed flags and validated values to gh", async () => {
    const seen: (readonly string[])[] = [];
    const run: ToolRun = (argv) => {
      seen.push(argv);
      return Promise.resolve({ code: 0, timedOut: false, stderr: "", stdout: JSON.stringify([{ number: 7, title: "Live", url: "https://github.com/a/b/pull/7", isDraft: true, state: "OPEN", updatedAt: "2026-11-03T16:00:00Z", author: { login: "ike" }, repository: { nameWithOwner: "a/b" } }]) });
    };
    const result = await queryTools(deps({ run })).github_prs({ filter: "review-requested", state: "open", repo: "a/b", limit: 5 });
    expect(seen[0]).toEqual(["gh", "search", "prs", "--review-requested=@me", "--limit=5", "--sort=updated", "--json=number,title,url,isDraft,state,updatedAt,author,repository", "--state=open", "--repo=a/b"]);
    expect(result).toMatchObject({ total: 1, prs: [{ repo: "a/b", number: 7, draft: true, state: "open", updatedAgo: "1h ago" }] });
  });

  it("relay_sessions leaves ended sessions out and filters by kind", async () => {
    const tools = queryTools(deps());
    expect(await tools.relay_sessions({ kind: "all", limit: 30 })).toMatchObject({
      total: 2,
      byStatus: [
        { name: "waiting", count: 1 },
        { name: "working", count: 1 },
      ],
      assistants: [{ id: "nova", status: "idle", lastReply: "Done." }],
    });
    expect(await tools.relay_sessions({ kind: "job", limit: 30 })).toMatchObject({ total: 1, sessions: [{ id: "s3", kind: "job" }] });
  });

  it("linear_issues says what is missing without a key", async () => {
    await expect(queryTools(deps()).linear_issues({ state: "active", limit: 25 })).rejects.toThrow(/no Linear key/);
  });

  it("goodops_collections says what is missing without the read-only env", async () => {
    await expect(queryTools(deps()).goodops_collections({ range: "7d" })).rejects.toThrow(/goodops-readonly\.env/);
  });

  it("goodops_collections returns aggregates only, from the database and FieldRoutes", async () => {
    const sqls: { text: string; params: readonly unknown[] }[] = [];
    const sql: GoodOpsSql = (text, params) => {
      sqls.push({ text, params });
      if (text.includes("min(created_at)"))
        return Promise.resolve([
          { customer: "101", office: "5", first: "2026-10-20 09:00:00" },
          { customer: "102", office: "5", first: "2026-11-02 10:00:00" },
        ]);
      return Promise.resolve([
        { day: "2026-11-03", status: "answered", flags: ["dispute"], n: 2 },
        { day: "2026-11-03", status: "voicemail", flags: [], n: 5 },
        { day: "2026-11-02", status: "answered", flags: [], n: 1 },
        { day: "2026-11-02", status: "texted", flags: [], n: 9 },
        { day: "2026-11-01", status: "dispatched", flags: [], n: 1 },
      ]);
    };
    const asked: { endpoint: string; params: URLSearchParams }[] = [];
    const fetch = (url: string, init: RequestInit): Promise<Response> => {
      const endpoint = url.replace("https://pestcc.pestroutes.com/api/", "");
      const params = new URLSearchParams(init.body as string);
      asked.push({ endpoint, params });
      const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
      if (endpoint === "office/search")
        return json({ offices: { a: { officeID: "5", officeName: "Pest Control Consultants Iowa" }, b: { officeID: "3", officeName: "Crown - TEMP" }, c: { officeID: "8", officeName: "Michigan" } } });
      if (endpoint === "customer/search" && !params.has("includeData")) return json({ customerIDs: [1, 2, 3] });
      // FieldRoutes answers customers as an array (and some endpoints keyed by id, as payments below).
      if (endpoint === "customer/search")
        return json({
          customers: [
            { responsibleBalance: "100.50", responsibleBalanceAge: "12", fname: "Ann", phone1: "5551234" },
            { responsibleBalance: "200.00", responsibleBalanceAge: "45" },
            { responsibleBalance: "50.00", responsibleBalanceAge: "120" },
          ],
        });
      if (endpoint === "payment/search" && !params.has("includeData")) return json({ paymentIDs: [11, 12, 13, 14, 15] });
      return json({
        payments: {
          11: { customerID: "101", date: "2026-11-03 07:30:00", amount: "100.50", status: "1", paymentSource: "Customer Portal" },
          12: { customerID: "102", date: "2026-11-02 09:00:00", amount: "40.00", status: "1", paymentSource: "Batch Process" },
          13: { customerID: "101", date: "2026-11-01 08:00:00", amount: "9.00", status: "0", paymentSource: "Manual" },
          14: { customerID: "102", date: "2026-11-01 09:00:00", amount: "5.00", status: "1", paymentSource: "Manual" },
          15: { customerID: "101", date: "2026-11-02 08:00:00", amount: "30.00", status: "1", writeOff: "1" },
        },
      });
    };
    const tools = queryTools(deps({ fetch, goodops: () => ({ sql, fr: { subdomain: "pestcc", key: "k", token: "t" } }) }));
    const result = await tools.goodops_collections({ range: "7d" });
    const parsed = QUERY_TOOLS.goodops_collections.result.parse(result);
    expect(parsed).toMatchObject({
      range: "7d",
      from: "2026-10-28",
      to: "2026-11-03",
      delinquency: {
        accounts: 3,
        amount: 350.5,
        amountText: "$351",
        buckets: [
          { bucket: "1-29d", accounts: 1, amount: 100.5 },
          { bucket: "30-59d", accounts: 1, amount: 200 },
          { bucket: "60-89d", accounts: 0, amount: 0 },
          { bucket: "90d+", accounts: 1, amount: 50 },
        ],
      },
      calls: {
        placed: 9,
        connected: 3,
        connectRate: 33,
        voicemail: 5,
        pending: 1,
        byStatus: [
          { name: "Voicemail", count: 5 },
          { name: "Answered", count: 3 },
          { name: "Pending", count: 1 },
        ],
        flags: [{ name: "Disputes the balance", count: 2 }],
      },
      // 12 is Pacific 09:00 = Central 11:00, after 102's 10:00 first contact; 13 failed; 14 came before it; 15 is a write-off.
      payments: { count: 2, customers: 2, amount: 140.5, amountText: "$141", customerDriven: { count: 1, amount: 100.5 } },
    });
    expect(parsed.calls.perDay).toHaveLength(7);
    expect(parsed.calls.perDay.at(-1)).toEqual({ date: "11-03", placed: 7, connected: 2 });
    expect(parsed.payments?.perDay.at(-1)).toEqual({ date: "11-03", count: 1, amount: 100.5, amountText: "$101" });
    // No customer field (names, phones, ids) survives into the answer.
    expect(JSON.stringify(parsed)).not.toMatch(/Ann|5551234|"101"|customerID/);
    // Only the program's offices are read; payments are asked for contacted customers, from the day before the range.
    expect(asked.filter((a) => a.endpoint === "customer/search").every((a) => a.params.get("officeIDs") === "5")).toBe(true);
    const paymentIds = asked.find((a) => a.endpoint === "payment/search");
    expect(paymentIds?.params.get("customerIDs")).toBe("[101,102]");
    expect(paymentIds?.params.get("date")).toBe(JSON.stringify({ operator: ">=", value: "2026-10-27" }));
    expect(sqls.find((s) => s.text.includes("count(*)"))?.params).toEqual(["2026-10-28"]);
    expect(sqls.every((s) => /^\s*select/i.test(s.text))).toBe(true);

    // FieldRoutes is cached: a second read only queries the calls again.
    const before = asked.length;
    await tools.goodops_collections({ range: "7d" });
    expect(asked.length).toBe(before);
  });

  it("goodops_collections still answers calls when FieldRoutes fails", async () => {
    const sql: GoodOpsSql = (text) => Promise.resolve(text.includes("min(created_at)") ? [{ customer: "101", office: "5", first: "2026-10-20 09:00:00" }] : []);
    const fetch = () => Promise.resolve(new Response("busy", { status: 503 }));
    const result = QUERY_TOOLS.goodops_collections.result.parse(
      await queryTools(deps({ fetch, goodops: () => ({ sql, fr: { subdomain: "pestcc", key: "k", token: "t" } }) })).goodops_collections({ range: "today" }),
    );
    expect(result).toMatchObject({ from: "2026-11-03", to: "2026-11-03", delinquency: null, payments: null, calls: { placed: 0, perDay: [{ date: "11-03", placed: 0, connected: 0 }] } });
    expect(result.unavailable).toEqual(expect.arrayContaining([expect.stringMatching(/^Delinquent book: FieldRoutes answered 503/), expect.stringMatching(/^Payments: FieldRoutes answered 503/)]));
  });
});

function fakeTools(over: Partial<Record<keyof QueryTools, () => Promise<unknown>>> = {}): { tools: QueryTools; reads: string[] } {
  const reads: string[] = [];
  const read = (name: keyof QueryTools, data: unknown) => () => {
    reads.push(name);
    return over[name]?.() ?? Promise.resolve(data);
  };
  const stamp = { asOf: "12:00:00", at: NOW, total: 1 };
  return {
    reads,
    tools: {
      work_items: read("work_items", { ...stamp, byWorkspace: [{ name: "Relay", count: 1 }], items: [{ key: "K", title: "T", workspace: "Relay", stage: "build", secret: "x" }] }),
      jobs: read("jobs", { ...stamp, failing: 0, jobs: [] }),
      linear_issues: read("linear_issues", { ...stamp, byState: [], issues: [] }),
      github_prs: read("github_prs", { ...stamp, prs: [] }),
      relay_sessions: read("relay_sessions", { ...stamp, byStatus: [], sessions: [], assistants: [] }),
      goodops_collections: read("goodops_collections", { ...stamp, range: "7d", from: "", to: "", delinquency: null, calls: {}, payments: null, unavailable: [] }),
    },
  };
}

describe("QueryService", () => {
  it("refuses tools off the allowlist and args their schema rejects, before reading anything", async () => {
    const { tools, reads } = fakeTools();
    const service = new QueryService(tools, () => NOW, () => undefined);
    expect(await service.run("shell", { cmd: "ls" }, "d")).toEqual({ ok: false, error: expect.stringMatching(/unknown query tool "shell"/) as unknown });
    expect(await service.run("work_items", { path: "/etc" }, "d")).toMatchObject({ ok: false, error: expect.stringMatching(/Unrecognized key/) as unknown });
    expect(await service.run("github_prs", { repo: "a/b --web" }, "d")).toMatchObject({ ok: false });
    expect(await service.run("__proto__", {}, "d")).toMatchObject({ ok: false });
    expect(reads).toEqual([]);
  });

  it("strips fields the result schema does not list, caches within the tool's ttl and shares one read in flight", async () => {
    let now = NOW;
    const { tools, reads } = fakeTools();
    const service = new QueryService(tools, () => now, () => undefined);
    const [a, b] = await Promise.all([service.run("work_items", {}, "d1"), service.run("work_items", { limit: 50 }, "d2")]);
    expect(reads).toEqual(["work_items"]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ ok: true, data: { items: [{ key: "K", title: "T", workspace: "Relay", stage: "build" }] } });
    expect(JSON.stringify(a)).not.toContain("secret");
    now += 5_000;
    await service.run("work_items", {}, "d1");
    expect(reads).toEqual(["work_items"]);
    now += 10_000;
    await service.run("work_items", {}, "d1");
    expect(reads).toEqual(["work_items", "work_items"]);
  });

  it("rate limits each caller and reports a failing source without caching it", async () => {
    let fail = true;
    const { tools, reads } = fakeTools({ jobs: () => (fail ? Promise.reject(new Error("ledger unreadable")) : Promise.resolve({ asOf: "1", at: 1, total: 0, failing: 0, jobs: [] })) });
    const service = new QueryService(tools, () => NOW, () => undefined);
    expect(await service.run("jobs", {}, "phone")).toEqual({ ok: false, error: "ledger unreadable" });
    fail = false;
    expect(await service.run("jobs", {}, "phone")).toMatchObject({ ok: true });
    expect(reads).toEqual(["jobs", "jobs"]);
    for (let i = 0; i < 118; i++) await service.run("jobs", {}, "phone");
    expect(await service.run("jobs", {}, "phone")).toEqual({ ok: false, error: expect.stringMatching(/rate limited/) as unknown });
    expect(await service.run("jobs", {}, "desktop")).toMatchObject({ ok: true });
  });
});

describe("POST /query", () => {
  const service = new QueryService(fakeTools().tools, () => NOW, () => undefined);
  const post = (headers: Record<string, string>, body: unknown) => new Request("http://h/query", { method: "POST", headers, body: JSON.stringify(body) });

  it("answers loopback JSON and refuses browsers and other machines", async () => {
    const ok = await handleQueryRequest(service, post({ "content-type": "application/json" }, { tool: "jobs" }), "127.0.0.1");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, data: { total: 1 } });
    expect((await handleQueryRequest(service, post({ "content-type": "application/json" }, { tool: "nope" }), "127.0.0.1")).status).toBe(422);
    expect((await handleQueryRequest(service, post({ "content-type": "application/json", origin: "http://evil" }, { tool: "jobs" }), "127.0.0.1")).status).toBe(403);
    expect((await handleQueryRequest(service, post({ "content-type": "text/plain" }, { tool: "jobs" }), "127.0.0.1")).status).toBe(415);
    expect((await handleQueryRequest(service, post({ "content-type": "application/json" }, { tool: "jobs" }), "100.64.0.2")).status).toBe(403);
    expect((await handleQueryRequest(null, post({ "content-type": "application/json" }, { tool: "jobs" }), "127.0.0.1")).status).toBe(404);
  });
});

const LIVE = `root = Card([s, list], "Work")
items = Query("work_items", {}, {total: 0, byWorkspace: [{name: "Loading", count: 0}]}, 30)
s = Stat("Open items", "" + items.total)
list = Rows(@Each(items.byWorkspace, "w", Row(w.name, "" + w.count)))`;

describe("live board widgets", () => {
  function store() {
    const dir = mkdtempSync(join(tmpdir(), "relay-boards-live-"));
    dirs.push(dir);
    const service = new QueryService(fakeTools().tools, () => NOW, () => undefined);
    return { boards: new FileBoardStore(dir, () => undefined, liveRender(service)), dir };
  }

  it("an openui upsert stores the source with its spec rendered from real query data", async () => {
    const { boards, dir } = store();
    await boards.put("ops", { title: "Ops" });
    const board = await boards.apply("ops", [{ op: "upsert", id: "work", span: 6, openui: LIVE, spec: { widget: "divider" } }]);
    expect(board.widgets).toEqual([
      {
        id: "work",
        span: 6,
        openui: LIVE,
        spec: { widget: "card", title: "Work", children: [{ widget: "stat", label: "Open items", value: "1" }, { widget: "rows", rows: [{ label: "Relay", value: "1" }] }] },
      },
    ]);
    // A restart reads it back as written.
    expect(new FileBoardStore(dir, () => undefined, null).get("ops")).toEqual(board);
    // Replacing it with a plain spec drops the source.
    const plain = await boards.apply("ops", [{ op: "upsert", id: "work", spec: { widget: "divider" } }]);
    expect(plain.widgets[0]).toEqual({ id: "work", span: 6, spec: { widget: "divider" } });
  });

  it("refuses a source that fails the live check, naming the widget and statement, and changes nothing", async () => {
    const { boards } = store();
    await boards.put("ops", { title: "Ops" });
    await expect(boards.apply("ops", [{ op: "upsert", id: "bad", openui: 'root = Text("x")\nq = Query("shell", {}, {})' }])).rejects.toThrow(/widget bad openui: q: unknown query tool "shell"/);
    await expect(boards.apply("ops", [{ op: "upsert", id: "bad", openui: 'root = Text("x")\nq = Query("jobs", {}, {}, 1)' }])).rejects.toThrow(/refresh is 1s/);
    await expect(boards.apply("ops", [{ op: "upsert", id: "bad" }])).rejects.toThrow(/needs a spec or an openui source/);
    expect(boards.get("ops")?.widgets).toEqual([]);
    expect(boards.rev).toBe(1);
  });

  it("a host without query tools refuses live tiles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-boards-live-"));
    dirs.push(dir);
    const boards = new FileBoardStore(dir, () => undefined, null);
    await expect(boards.put("ops", { title: "Ops", widgets: [{ id: "w", openui: LIVE }] })).rejects.toThrow(/query tools/);
  });

  it("liveRefusal explains Mutation and parse errors", () => {
    expect(liveRefusal(LIVE)).toBeNull();
    expect(liveRefusal('root = Text("x")\nm = Mutation("jobs", {})')).toMatch(/m: Relay widgets don't run Mutation/);
    expect(liveRefusal("root = Card([")).toMatch(/ends mid-statement/);
  });
});
