import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@relay/protocol";
import { ask, type AskAnswer } from "../src/widgets/bus";
import { GATE_DEFAULTS, widgetGate } from "../src/widgets/gate";
import { AUTO_ASK_WAIT_MS, autoAskSettings, ReplyWidgetService, surfaceOf, widgetMode, type FinishedReply } from "../src/widgets/service";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BLOCK = '```openui\nroot = Stat("Boards sold", "42")\n```';
/** A reply the gate lets through: four measures (37 -> 42, $1,260, 12%). */
const TEXT = "Boards sold went from 37 to 42 this month, $1,260 in sales, up 12%.";

interface Line {
  type: string;
  data: Record<string, unknown>;
}
const journal = (home: string): Line[] =>
  existsSync(join(home, "events.ndjson"))
    ? readFileSync(join(home, "events.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Line)
    : [];
const jsonl = (home: string, file: string): Record<string, unknown>[] =>
  existsSync(join(home, "bench", "widget", file))
    ? readFileSync(join(home, "bench", "widget", file), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-widgets-"));
  dirs.push(dir);
  const home = join(dir, "atomic-agents");
  mkdirSync(home, { recursive: true });
  return home;
}

function setup(options: { mode?: string; autoAsk?: Record<string, unknown>; answer?: AskAnswer["reply"]; messages?: Record<string, string>; askMs?: number } = {}) {
  const home = tempHome();
  const setMode = (mode: string | undefined): void => {
    const widget = { ...(mode === undefined ? {} : { mode }), ...(options.autoAsk === undefined ? {} : { autoAsk: options.autoAsk }) };
    writeFileSync(join(home, "config.json"), JSON.stringify({ components: { widget } }));
  };
  setMode(options.mode);
  const asked: Readonly<Record<string, unknown>>[] = [];
  const waits: number[] = [];
  const sent: ServerMessage[] = [];
  const logs: string[] = [];
  let clock = 1_000_000;
  const service = new ReplyWidgetService({
    home,
    path: join(home, "..", "relay", "reply-widgets.json"),
    surface: () => "phone",
    message: (thread, key) => Promise.resolve(options.messages?.[`${thread} ${key}`] ?? null),
    broadcast: (message) => sent.push(message),
    now: () => clock,
    log: (line) => logs.push(line),
    ask: (request, timeoutMs) => {
      asked.push(request);
      waits.push(timeoutMs);
      clock += options.askMs ?? 0;
      const reply = options.answer === undefined ? { kind: "openui", block: BLOCK, why: "one headline number" } : options.answer;
      return Promise.resolve({ requestId: `req-${String(asked.length)}`, reply: reply === null ? null : { requestId: `req-${String(asked.length)}`, ...reply } });
    },
  });
  return { home, service, sent, asked, waits, logs, setMode };
}

const reply = (fields: Partial<FinishedReply> = {}): FinishedReply => ({
  agent: "nova",
  sessionId: "nova-1",
  message: "assistant@1000",
  text: TEXT,
  turn: { text: "How many boards did we sell? Give me the details", voice: false },
  ...fields,
});

describe("reply widget hook", () => {
  it("shadow (the default) logs the suggestion with draft hash, excerpt, signals, why and latency, and shows nothing", async () => {
    const h = setup();
    await h.service.reply(reply());
    expect(h.asked).toEqual([{ draft: TEXT, surface: "phone", context: { channel: "text", askedForDetail: true } }]);
    const [line] = jsonl(h.home, "shadow.jsonl");
    expect(line).toMatchObject({ mode: "shadow", agent: "nova", message: "assistant@1000", kind: "openui", block: BLOCK, why: "one headline number", shown: false, excerpt: TEXT, signals: ["numbers"], requestId: "req-1" });
    expect(line?.["draftHash"]).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof line?.["ms"]).toBe("number");
    expect(journal(h.home).map((event) => [event.type, event.data["mode"], event.data["shown"]])).toEqual([["widget/widget.logged", "shadow", false]]);
    expect(h.sent).toEqual([]);
    expect(h.service.snapshot("assistant:nova")).toEqual({});
  });

  it("live shows an openui answer under its reply on every device; switching mode needs no restart", async () => {
    const h = setup({ mode: "live" });
    await h.service.reply(reply());
    expect(h.sent).toEqual([{ t: "widgets.snapshot", thread: "assistant:nova", widgets: { "assistant@1000": BLOCK } }]);
    h.setMode("off");
    await h.service.reply(reply({ message: "assistant@2000" }));
    h.setMode("shadow");
    await h.service.reply(reply({ message: "assistant@3000" }));
    expect(h.asked).toHaveLength(2);
    expect(jsonl(h.home, "shadow.jsonl").map((line) => [line["message"], line["mode"], line["shown"]])).toEqual([
      ["assistant@1000", "live", true],
      ["assistant@3000", "shadow", false],
    ]);
    expect(h.service.snapshot("assistant:nova")).toEqual({ "assistant@1000": BLOCK });
  });

  it("asks nothing for a voice-call turn or a reply that already holds a widget", async () => {
    const h = setup({ mode: "live" });
    await h.service.reply(reply({ turn: { text: "how many boards", voice: true } }));
    await h.service.reply(reply({ text: `Here:\n\n${BLOCK}` }));
    expect(h.asked).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("no answer within the wait is logged as a timeout with the ms it waited and shows nothing, even live", async () => {
    const h = setup({ mode: "live", answer: null, askMs: AUTO_ASK_WAIT_MS });
    await h.service.reply(reply());
    expect(jsonl(h.home, "shadow.jsonl")).toMatchObject([{ kind: "timeout", shown: false, ms: AUTO_ASK_WAIT_MS }]);
    expect(h.sent).toEqual([]);
    expect(h.logs).toContain(`widgets: nova assistant@1000: live timeout in ${String(AUTO_ASK_WAIT_MS)} ms (numbers)`);
  });

  it("an answer slower than the old 3 s window is still shown under its reply, logged with its real ms", async () => {
    const h = setup({ mode: "live", askMs: 7_395 });
    await h.service.reply(reply());
    expect(h.waits).toEqual([AUTO_ASK_WAIT_MS]);
    expect(jsonl(h.home, "shadow.jsonl")).toMatchObject([{ kind: "openui", shown: true, ms: 7_395 }]);
    expect(h.sent).toEqual([{ t: "widgets.snapshot", thread: "assistant:nova", widgets: { "assistant@1000": BLOCK } }]);
  });

  it("asks nothing for a reply without structured data, and logs which counts fell short", async () => {
    const h = setup({ mode: "live" });
    await h.service.reply(reply({ text: "Done. The fix is merged and the host restarted cleanly." }));
    expect(h.asked).toEqual([]);
    expect(existsSync(join(h.home, "bench", "widget", "shadow.jsonl"))).toBe(false);
    expect(h.logs).toEqual(["widgets: nova assistant@1000: no widget data (numbers 0 of 3, items 0 of 3, keys 0 of 2, media 0 of 2), skipped"]);
  });

  it("takes the gate's limits and the wait from components.widget.autoAsk", async () => {
    const strict = setup({ autoAsk: { numbers: 5 } });
    await strict.service.reply(reply());
    expect(strict.asked).toEqual([]);
    const loose = setup({ autoAsk: { numbers: 4, waitMs: 9_000 } });
    await loose.service.reply(reply());
    expect(loose.waits).toEqual([9_000]);
    expect(autoAskSettings(null)).toEqual({ limits: GATE_DEFAULTS, waitMs: AUTO_ASK_WAIT_MS });
    expect(autoAskSettings({ components: { widget: { autoAsk: { keys: 1, media: 3 } } } })).toEqual({ limits: { ...GATE_DEFAULTS, keys: 1, media: 3 }, waitMs: AUTO_ASK_WAIT_MS });
    expect(autoAskSettings({ components: { widget: { autoAsk: { keys: 0 } } } })).toEqual({ limits: GATE_DEFAULTS, waitMs: AUTO_ASK_WAIT_MS });
  });

  it("an automatic answer landing after Isaac's 🎯 label on that reply is logged but never shown", async () => {
    const home = tempHome();
    writeFileSync(join(home, "config.json"), JSON.stringify({ components: { widget: { mode: "live" } } }));
    const sent: ServerMessage[] = [];
    const logs: string[] = [];
    const answer = Promise.withResolvers<AskAnswer>();
    const service = new ReplyWidgetService({
      home,
      path: join(home, "..", "relay", "reply-widgets.json"),
      surface: () => "phone",
      message: () => Promise.resolve(TEXT),
      broadcast: (message) => sent.push(message),
      now: () => Date.now(),
      log: (line) => logs.push(line),
      ask: () => answer.promise,
    });
    const pending = service.reply(reply());
    expect(await service.label({ thread: "assistant:nova", message: "assistant@1000", label: "keep", surface: "phone", excerpt: "Boards" })).toEqual({ ok: true });
    answer.resolve({ requestId: "r1", reply: { requestId: "r1", kind: "openui", block: BLOCK, why: "late" } });
    await pending;
    expect(service.snapshot("assistant:nova")).toEqual({});
    expect(sent).toEqual([]);
    expect(jsonl(home, "shadow.jsonl")).toMatchObject([{ kind: "openui", shown: false }]);
    expect(logs.at(-1)).toMatch(/live openui in \d+ ms \(numbers\), after Isaac's label, not kept$/);
  });

  it("reads the mode from config.json: disabled is off, no mode is shadow", () => {
    expect(widgetMode(null)).toBe("shadow");
    expect(widgetMode({ components: { widget: { model: "m" } } })).toBe("shadow");
    expect(widgetMode({ components: { widget: { mode: "live" } } })).toBe("live");
    expect(widgetMode({ components: { widget: { mode: "live", enabled: false } } })).toBe("off");
  });

  it("Isaac reads on the desktop only while it had input in the last 5 minutes", () => {
    expect(surfaceOf([], 1_000_000)).toBe("phone");
    expect(surfaceOf([{ lastInputAt: null }, { lastInputAt: 1_000_000 - 60_000 }], 1_000_000)).toBe("desktop");
    expect(surfaceOf([{ lastInputAt: 1_000_000 - 6 * 60_000 }], 1_000_000)).toBe("phone");
  });
});

describe("widget gate", () => {
  const fired = (text: string): readonly string[] => widgetGate(text).signals;

  it("lets through measures to compare: currency, %, units, either side of a comparison", () => {
    expect(widgetGate("Free space is 40 GB, swap grew to 26 GB, and the cache holds 85 GB.").counts.numbers).toBe(3);
    expect(fired("Accuracy was 66.7% against a 75% target; the baseline got 41.7%.")).toEqual(["numbers"]);
    expect(fired("The Dyson is $599.99 and the Bissell $259.99, with 5 years of warranty.")).toEqual(["numbers"]);
    expect(fired("Tokens went from 6843 to 5231, under the 6000 limit.")).toEqual([]);
    expect(fired("Version 0.2.106 is out, see gpt-6 and v2 for the 3 of us.")).toEqual([]);
  });

  it("lets through a table or a list carrying numbers, not a list of prose points", () => {
    expect(fired("| Category | v1 | v2 |\n|---|---|---|\n| Sky | 7 | 6 |\n| Turf | 5 | 6 |\n| Trees | 6 | 5 |")).toEqual(["items"]);
    expect(fired("Sky and light: v1 5, v2 8.\nTurf: v1 6, v2 7.\nTrees: v1 4, v2 5.")).toEqual(["items"]);
    expect(fired("- 18 boards in stock\n- 4 on order\n- 2 returned")).toEqual(["items"]);
    expect(fired("- **Safety:** low risk.\n- **Evidence:** we copied it.\n- **Offline:** for good.")).toEqual([]);
  });

  it("lets through two distinct ticket or PR keys", () => {
    expect(fired("ENG-6832 is on stage; ENG-7451 is only on develop.")).toEqual(["keys"]);
    expect(fired("PR #5 is merged and ENG-6827 moves to QA.")).toEqual(["keys"]);
    expect(fired("ENG-6832 is on stage, ENG-6832 again.")).toEqual([]);
  });

  it("lets through two images, or one with before/after wording", () => {
    expect(fired("![grid](/drops/a/1)\n![photo](/drops/b/2)")).toEqual(["media"]);
    expect(fired("Before:\n![menu before](/drops/a/1)\nAfter: it lines up now.")).toEqual(["media"]);
    expect(fired("The diagram agent made this:\n\n![loop](/drops/a/1)")).toEqual([]);
  });

  it("counts nothing inside code fences and nothing in plain prose", () => {
    expect(widgetGate("```ts\nconst a = 5 ms, b = 6 ms, c = 7 ms;\n```").eligible).toBe(false);
    expect(widgetGate("Done. The fix is merged and the host restarted cleanly.")).toEqual({ eligible: false, signals: [], counts: { numbers: 0, items: 0, keys: 0, media: 0 }, beforeAfter: false });
  });

  it("each limit is a parameter", () => {
    expect(widgetGate("ENG-1 shipped.", { ...GATE_DEFAULTS, keys: 1 }).signals).toEqual(["keys"]);
    expect(widgetGate("Free space is 40 GB, swap 26 GB, cache 85 GB.", { ...GATE_DEFAULTS, numbers: 4 }).eligible).toBe(false);
  });
});

describe("atomic-agents journal ask", () => {
  // The bus is a file other processes append to; these exercise the real file tail and its real-time deadline.
  it("answers the reply carrying its requestId, skipping other requests' replies", async () => {
    const home = tempHome();
    const file = join(home, "events.ndjson");
    writeFileSync(file, "");
    const agent = watch(file, () => {
      const request = journal(home).find((event) => event.type === "widget/widget.requested");
      if (request === undefined || journal(home).some((event) => event.type === "widget/widget.ready")) return;
      const line = (requestId: unknown, kind: string): string => `${JSON.stringify({ id: kind, type: "widget/widget.ready", component: "widget", job: "pick", run: "r", at: "", data: { requestId, kind, why: kind } })}\n`;
      appendFileSync(file, `${line("someone-else", "none")}{torn\n${line(request.data["requestId"], "openui")}`);
    });
    try {
      const answer = await ask(home, "widget", { request: "widget.requested", reply: "widget.ready" }, { draft: "d", surface: "phone" }, { timeoutMs: 3_000 });
      expect(answer.reply).toEqual({ requestId: answer.requestId, kind: "openui", why: "openui" });
    } finally {
      agent.close();
    }
  });

  it("answers null once the timeout passes with no reply", async () => {
    const home = tempHome();
    const started = Date.now();
    const answer = await ask(home, "widget", { request: "widget.requested", reply: "widget.ready" }, { draft: "d", surface: "phone" }, { timeoutMs: 120 });
    expect(answer.reply).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
    expect(journal(home).map((event) => [event.type, event.data["requestId"]])).toEqual([["widget/widget.requested", answer.requestId]]);
  });
});

describe("🎯 widget training", () => {
  it("saves the reply, what was shown under it, the suggestion and Isaac's answer, and emits widget.labeled", async () => {
    const h = setup({ mode: "live", messages: { "assistant:nova assistant@1000": "We sold 42 boards this month." } });
    await h.service.reply(reply());
    const result = await h.service.label({ thread: "assistant:nova", message: "assistant@1000", label: "chart", surface: "desktop", excerpt: "We sold 42 boards" });
    expect(result).toEqual({ ok: true });
    expect(jsonl(h.home, "training.jsonl")).toMatchObject([
      {
        agent: "nova",
        message: "assistant@1000",
        surface: "desktop",
        label: "chart",
        answer: "Chart",
        excerpt: "We sold 42 boards",
        draft: "We sold 42 boards this month.",
        shown: { kind: "openui", source: "widget", block: BLOCK },
        suggestion: { kind: "openui", mode: "live", block: BLOCK, why: "one headline number" },
      },
    ]);
    expect(journal(h.home).find((event) => event.type === "widget/widget.labeled")?.data).toEqual({ agent: "nova", message: "assistant@1000", surface: "desktop", label: "chart", shown: "openui" });
  });

  it("a reply's own widget is what was shown; a reply the thread lost is saved from its excerpt; only assistant replies count", async () => {
    const h = setup({ messages: { "assistant:nova assistant@5": `Totals:\n\n${BLOCK}` } });
    expect(await h.service.label({ thread: "assistant:nova", message: "assistant@5", label: "keep", surface: "phone", excerpt: "Totals:" })).toEqual({ ok: true });
    expect(await h.service.label({ thread: "assistant:nova", message: "assistant@6", label: "plain", surface: "phone", excerpt: "Gone reply" })).toEqual({ ok: true });
    expect(await h.service.label({ thread: "session:s1", message: "assistant@7", label: "plain", surface: "phone", excerpt: "x" })).toMatchObject({ ok: false });
    expect(jsonl(h.home, "training.jsonl").map((line) => [line["message"], line["draft"], line["shown"]])).toEqual([
      ["assistant@5", `Totals:\n\n${BLOCK}`, { kind: "openui", source: "reply", block: BLOCK }],
      ["assistant@6", "Gone reply", { kind: "none" }],
    ]);
  });

  const TABLE = '```openui\nroot = Table([Column("Month", ["Jan"])])\n```';
  const table = { thread: "assistant:nova", message: "assistant@1000", label: "table", surface: "desktop", excerpt: "We sold" } as const;

  it("a form pick saves first, then asks the widget agent for exactly that form over the reply and shows it whatever the mode", async () => {
    const h = setup({ answer: { kind: "openui", block: TABLE, why: "picked" }, messages: { "assistant:nova assistant@1000": "Jan 42, Feb 51." } });
    expect(await h.service.label(table)).toEqual({ ok: true });
    await vi.waitFor(() => expect(h.service.snapshot("assistant:nova")).toEqual({ "assistant@1000": TABLE }));
    expect(h.asked).toEqual([{ draft: "Jan 42, Feb 51.", surface: "desktop", context: { channel: "text", askedForDetail: false }, form: "table" }]);
    expect(h.sent).toEqual([{ t: "widgets.snapshot", thread: "assistant:nova", widgets: { "assistant@1000": TABLE } }]);
    expect(jsonl(h.home, "training.jsonl")).toHaveLength(1);
  });

  it("shows nothing when the agent has no widget for the form or times out, and 'plain' takes a shown widget off", async () => {
    const none = setup({ answer: { kind: "none", why: "no data" }, messages: { "assistant:nova assistant@1000": "Hello." } });
    await none.service.label(table);
    await vi.waitFor(() => expect(none.asked).toHaveLength(1));
    const late = setup({ answer: null, messages: { "assistant:nova assistant@1000": "Hello." } });
    await late.service.label(table);
    await vi.waitFor(() => expect(late.asked).toHaveLength(1));
    expect([none.sent, late.sent, none.service.snapshot("assistant:nova"), late.service.snapshot("assistant:nova")]).toEqual([[], [], {}, {}]);

    const h = setup({ mode: "live", messages: { "assistant:nova assistant@1000": "We sold 42 boards this month." } });
    await h.service.reply(reply());
    expect(h.service.snapshot("assistant:nova")).toEqual({ "assistant@1000": BLOCK });
    await h.service.label({ ...table, label: "plain" });
    await vi.waitFor(() => expect(h.service.snapshot("assistant:nova")).toEqual({}));
    expect(h.asked).toHaveLength(1);
    expect(h.sent.at(-1)).toEqual({ t: "widgets.snapshot", thread: "assistant:nova", widgets: {} });
  });
});
