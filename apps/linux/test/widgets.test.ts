import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@relay/protocol";
import { ask, type AskAnswer } from "../src/widgets/bus";
import { ReplyWidgetService, surfaceOf, widgetMode, type FinishedReply } from "../src/widgets/service";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BLOCK = '```openui\nroot = Stat("Boards sold", "42")\n```';

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

function setup(options: { mode?: string; answer?: AskAnswer["reply"]; messages?: Record<string, string> } = {}) {
  const home = tempHome();
  const setMode = (mode: string | undefined): void => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ components: mode === undefined ? {} : { widget: { mode } } }));
  };
  setMode(options.mode);
  const asked: Readonly<Record<string, unknown>>[] = [];
  const sent: ServerMessage[] = [];
  const service = new ReplyWidgetService({
    home,
    path: join(home, "..", "relay", "reply-widgets.json"),
    surface: () => "phone",
    message: (thread, key) => Promise.resolve(options.messages?.[`${thread} ${key}`] ?? null),
    broadcast: (message) => sent.push(message),
    now: () => Date.now(),
    log: () => undefined,
    ask: (request) => {
      asked.push(request);
      const reply = options.answer === undefined ? { kind: "openui", block: BLOCK, why: "one headline number" } : options.answer;
      return Promise.resolve({ requestId: `req-${String(asked.length)}`, reply: reply === null ? null : { requestId: `req-${String(asked.length)}`, ...reply } });
    },
  });
  return { home, service, sent, asked, setMode };
}

const reply = (fields: Partial<FinishedReply> = {}): FinishedReply => ({
  agent: "nova",
  sessionId: "nova-1",
  message: "assistant@1000",
  text: "We sold 42 boards this month.",
  turn: { text: "How many boards did we sell? Give me the details", voice: false },
  ...fields,
});

describe("reply widget hook", () => {
  it("shadow (the default) logs the suggestion with draft hash, excerpt, why and latency, and shows nothing", async () => {
    const h = setup();
    await h.service.reply(reply());
    expect(h.asked).toEqual([{ draft: "We sold 42 boards this month.", surface: "phone", context: { channel: "text", askedForDetail: true } }]);
    const [line] = jsonl(h.home, "shadow.jsonl");
    expect(line).toMatchObject({ mode: "shadow", agent: "nova", message: "assistant@1000", kind: "openui", block: BLOCK, why: "one headline number", shown: false, excerpt: "We sold 42 boards this month.", requestId: "req-1" });
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

  it("no answer in time is logged as a timeout and shows nothing, even live", async () => {
    const h = setup({ mode: "live", answer: null });
    await h.service.reply(reply());
    expect(jsonl(h.home, "shadow.jsonl")).toMatchObject([{ kind: "timeout", shown: false }]);
    expect(h.sent).toEqual([]);
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
});
