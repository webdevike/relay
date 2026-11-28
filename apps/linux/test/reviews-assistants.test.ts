import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AstraItem, LinearTicket } from "@relay/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchOptions } from "../src/agents/herdr";
import { AstraSessions, ITEM_SESSION_TOOLS, type AstraSessionsDeps } from "../src/reviews/astra";
import { ticketContext } from "../src/reviews/context";
import { systemClock } from "../src/session";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-assistants-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const URL = "https://github.com/o/r/pull/1";
const TOOLS = `--tools=${ITEM_SESSION_TOOLS}`;

const session = (id: string, status: AgentSession["status"]): AgentSession => ({
  id,
  provider: "omp",
  title: "x",
  projectPath: "/eva",
  status,
  lastActivity: "",
  lastActivityAt: 0,
  canRespond: true,
});

function home(): string {
  const root = join(dir, "home");
  const agents = join(root, ".omp", "assistant", "agents");
  for (const id of ["astra", "nova"]) {
    mkdirSync(join(agents, id), { recursive: true });
    writeFileSync(join(agents, id, "prime.md"), `You are ${id}.`);
  }
  writeFileSync(join(root, ".omp", "assistant", "agents.json"), JSON.stringify({ agents: [{ id: "astra", title: "Astra" }, { id: "nova", title: "Nova", model: "gpt" }] }));
  mkdirSync(join(root, "work", "eva", "agents", "nova"), { recursive: true });
  writeFileSync(join(root, "work", "eva", "agents", "nova", "thread.md"), "Nova remembers ENG-1.");
  return root;
}

function setup(over: Partial<AstraSessionsDeps> = {}) {
  const launches: LaunchOptions[] = [];
  const joins: ((id: string) => void)[] = [];
  const sessions: AgentSession[] = [];
  const replies: string[] = [];
  const emitted: AstraItem[] = [];
  const files = new Map<string, string>();
  const astra = new AstraSessions({
    agents: {
      sessions,
      conversation: () => Promise.resolve([]),
      reply: (id, text) => {
        replies.push(`${id}:${text}`);
        return Promise.resolve();
      },
      configure: () => Promise.resolve(),
    },
    launch: (options) => {
      launches.push(options);
      const { promise, resolve } = Promise.withResolvers<string>();
      joins.push(resolve);
      return Promise.resolve({ joined: promise });
    },
    sessionFile: (id) => files.get(id) ?? null,
    agentHome: home(),
    socketPath: "/tmp/test-agents.sock",
    storePath: join(dir, "reviews", "astra.json"),
    emit: (item) => emitted.push(item),
    clock: systemClock,
    log: () => undefined,
    readOnly: true,
    ...over,
  });
  return { astra, launches, joins, sessions, replies, emitted, files };
}

const store = (): Record<string, { sessionId: string | null }> =>
  JSON.parse(readFileSync(join(dir, "reviews", "astra.json"), "utf8")) as Record<string, { sessionId: string | null }>;

function expectReadOnly(launch: LaunchOptions | undefined): void {
  const gh = join(dir, "reviews", "assistant-gh");
  expect(launch?.ompArgs).toContain(TOOLS);
  expect(launch?.env).toMatchObject({ LINEAR_API_KEY: "", GH_TOKEN: "", GITHUB_TOKEN: "", GH_CONFIG_DIR: gh });
  expect(readdirSync(gh)).toEqual([]);
}

describe("item sessions per assistant", () => {
  it("gives Nova her own read-only session on an item Astra already has, and resumes it under the same rules", async () => {
    const t = setup();
    await t.astra.ask(URL, "Astra · o/r#1", "o/r#1", () => Promise.resolve("### PR"), "@Astra is it safe?");
    const nova = await t.astra.ask(URL, "Nova · o/r#1", "o/r#1", () => Promise.resolve("### PR"), "@Nova and you?", "@Nova and you?", "nova");
    expect(t.launches).toHaveLength(2);
    expect(nova).toMatchObject({ url: URL, agent: "nova", title: "Nova · o/r#1", working: true, turns: [{ text: "@Nova and you?" }] });
    expect(t.launches[1]).toMatchObject({ label: "Nova · o/r#1", model: "gpt" });
    const prompt = t.launches[1]?.prompt ?? "";
    expect(prompt.startsWith("You are nova.")).toBe(true);
    for (const part of ["Nova remembers ENG-1.", "every @Nova question", "can only read"]) expect(prompt).toContain(part);
    for (const launch of t.launches) expectReadOnly(launch);

    t.sessions.push(session("a1", "idle"), session("n1", "idle"));
    t.files.set("n1", join(dir, "n1.jsonl"));
    writeFileSync(join(dir, "n1.jsonl"), "");
    t.joins.forEach((join_, i) => join_(["a1", "n1"][i] ?? ""));
    await vi.waitFor(() => {
      expect(store()).toMatchObject({ [URL]: { sessionId: "a1" }, [`nova|${URL}`]: { sessionId: "n1" } });
    });
    expect(await t.astra.snapshot(URL)).not.toHaveProperty("agent");
    expect(await t.astra.snapshot(URL, "nova")).toMatchObject({ sessionId: "n1" });

    // A live session gets the next ask as a turn; once it ended, the ask resumes its file with the same rules.
    await t.astra.ask(URL, "Nova · o/r#1", "o/r#1", () => Promise.reject(new Error("unused")), "more?", "more?", "nova");
    expect(t.replies).toEqual(["n1:more?"]);
    t.sessions.splice(1, 1);
    await t.astra.ask(URL, "Nova · o/r#1", "o/r#1", () => Promise.reject(new Error("unused")), "still there?", "still there?", "nova");
    expect(t.launches).toHaveLength(3);
    expect(t.launches[2]).toMatchObject({ resume: join(dir, "n1.jsonl"), prompt: "still there?" });
    expectReadOnly(t.launches[2]);
    t.astra.stop();
  });

  it("reads old astra.json entries (bare url) as Astra's and does not reuse a live session started without the rules", async () => {
    mkdirSync(join(dir, "reviews"), { recursive: true });
    writeFileSync(join(dir, "reviews", "astra.json"), JSON.stringify({ [URL]: { title: "Astra · o/r#1", sessionFile: null, sessionId: "old" } }));
    const t = setup();
    t.sessions.push(session("old", "idle"));
    expect(await t.astra.snapshot(URL)).toMatchObject({ url: URL, title: "Astra · o/r#1", sessionId: "old" });
    expect(await t.astra.snapshot(URL, "nova")).toBeNull();
    await t.astra.ask(URL, "Astra · o/r#1", "o/r#1", () => Promise.resolve("### PR"), "@Astra again?");
    expect(t.replies).toEqual([]);
    expect(t.launches).toHaveLength(1);
    expect(t.launches[0]?.resume).toBeUndefined();
    expectReadOnly(t.launches[0]);
    t.astra.stop();
  });

  it("refuses an assistant id that could leave the agents folder", async () => {
    const t = setup();
    await expect(t.astra.ask(URL, "x", "x", () => Promise.resolve(""), "q", "q", "../astra")).rejects.toThrow("Not an assistant id");
    expect(t.launches).toEqual([]);
    expect(existsSync(join(dir, "reviews", "astra.json"))).toBe(false);
  });
});

describe("ticket context", () => {
  it("adds the thread he asked from and the passage he pointed at", () => {
    const comment = (id: string, parentId: string | null, body: string) => ({ id, parentId, body, author: { name: id.toUpperCase() }, at: 0 });
    const ticket = {
      key: "ENG-1",
      title: "Fix",
      url: "https://linear.app/x/issue/ENG-1",
      state: { name: "Todo" },
      priority: "High",
      assignee: null,
      project: null,
      team: "ENG",
      parent: null,
      children: [],
      links: [],
      description: "Desc",
      comments: [comment("a", null, "root A"), comment("b", null, "root B"), comment("c", "a", "reply to A")],
    } as unknown as LinearTicket;
    const plain = ticketContext(ticket);
    expect(plain).not.toContain("#### The thread");
    const focused = ticketContext(ticket, { threadId: "a", quote: "line one\nline two" });
    expect(focused.startsWith(plain)).toBe(true);
    const thread = focused.slice(focused.indexOf("#### The thread he is asking from"));
    expect(thread).toContain("- A, : root A");
    expect(thread).toContain("- C, : reply to A");
    expect(thread).not.toContain("root B");
    expect(focused.endsWith("#### The passage he is pointing at\n> line one\n> line two")).toBe(true);
  });
});
