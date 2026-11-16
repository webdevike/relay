import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@relay/protocol";
import { agentMessageOf } from "../src/agents/agent-rows";
import { OmpBridgeProvider } from "../src/agents/bridge";
import { AgentCalls, parseSessionRows } from "../src/agents/transcript";
import { toAssistantMessages } from "../src/assistant/service";
import type { AgentProviderChange } from "../src/seams";

/** omp's xd device call for a relay MCP tool: `write` to `xd://mcp__relay_<tool>` with the arguments as JSON. */
const xd = (tool: string, args: object): { path: string; content: string } => ({
  path: `xd://mcp__relay_${tool}`,
  content: JSON.stringify(args),
});
const ask = {
  agent: "web-researcher",
  request: { question: "Best SSD enclosure?", depth: "quick" },
};
const done = (run: string, agent = "web-researcher", seconds = 29.4): string =>
  JSON.stringify({
    run,
    agent,
    status: "done",
    request: { question: "Best SSD enclosure?" },
    reply: {
      answer: "Acasis.",
      citations: [
        { url: "https://a.example", quote: "fast", verified: true },
        { url: "https://b.example", quote: "ok", verified: false },
      ],
      model: "x",
    },
    text: "Acasis.",
    requestedAt: "2026-11-16T10:00:00.000Z",
    seconds,
    cost: 0.004,
  });
const running = (run: string): string =>
  JSON.stringify({
    run,
    agent: "web-researcher",
    status: "running",
    requestedAt: "2026-11-16T10:00:00.000Z",
  });

/** One session-file line per entry, as omp writes them. */
const line = (message: object): string => JSON.stringify({ type: "message", message });
const user = (text: string, timestamp: number): string =>
  line({ role: "user", content: text, timestamp });
const said = (text: string, timestamp: number): string =>
  line({ role: "assistant", content: [{ type: "text", text }], timestamp });
const call = (id: string, tool: string, args: object, timestamp: number): string =>
  line({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "write", arguments: xd(tool, args) }],
    timestamp,
  });
const result = (id: string, text: string, timestamp: number, isError = false): string =>
  line({
    role: "toolResult",
    toolCallId: id,
    toolName: "write",
    content: [{ type: "text", text }],
    isError,
    timestamp,
  });

/** The host's rows of a session file. */
function rows(lines: string[]): AgentMessage[] {
  let seq = 0;
  return parseSessionRows(lines.join("\n"), null, () => `r${String(++seq)}`).map(agentMessageOf);
}

describe("agents calls in transcript rows", () => {
  it("reads an ask's row as running until its result, then done with the reply, and never passes the raw call on", () => {
    const out = rows([user("find one", 1), call("t1", "agents_ask", ask, 2)]);
    expect(out[1]).toMatchObject({
      role: "tool",
      agentRun: { agent: "web-researcher", status: "running", startedAt: 2, request: ask.request },
    });
    expect(out[1]).not.toHaveProperty("agentTool");
    const finished = rows([
      user("find one", 1),
      call("t1", "agents_ask", ask, 2),
      result("t1", done("run-1"), 30),
    ]);
    expect(finished).toHaveLength(2);
    expect(finished[1]?.agentRun).toMatchObject({
      run: "run-1",
      status: "done",
      seconds: 29.4,
      sources: 1,
      text: "Acasis.",
      startedAt: Date.parse("2026-11-16T10:00:00.000Z"),
    });
    expect(finished[1]?.agentRun?.reply).not.toHaveProperty("model");
  });

  it("leaves other tool rows alone", () => {
    const out = rows([
      line({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "write",
            arguments: { path: "notes.md", content: "agents_ask" },
          },
        ],
        timestamp: 1,
      }),
      result("t1", "ok", 2),
    ]);
    expect(out[0]).not.toHaveProperty("agentRun");
  });

  it("finds a call's row for a result read in a later piece of the file, and says which row moved", () => {
    const moved: string[] = [];
    const calls = new AgentCalls((row) => {
      moved.push(row.id);
    });
    let seq = 0;
    const first = parseSessionRows(
      call("t1", "agents_ask", ask, 2),
      null,
      () => `r${String(++seq)}`,
      calls,
    );
    parseSessionRows(result("t1", done("run-1"), 30), null, () => `r${String(++seq)}`, calls);
    expect(moved).toEqual([first[0]?.id]);
    expect(first.map(agentMessageOf)[0]?.agentRun?.status).toBe("done");
  });
});

describe("agents runs over the live bridge", () => {
  it("reads the run on the appended tool row, then on the result's `message.agent` frame", () => {
    const provider = new OmpBridgeProvider("/unused.sock", () => undefined, null);
    const changes: AgentProviderChange[] = [];
    provider.onChange = (change) => {
      changes.push(change);
    };
    const connection = {
      socket: { write: (bytes: Uint8Array) => bytes.length, end: () => undefined },
      buffer: "",
      outbound: null,
      session: null,
      sessionFile: null,
      pending: new Map(),
      gate: undefined,
      pid: null,
      herdrPane: null,
      retired: false,
      gone: Promise.withResolvers<undefined>(),
    };
    const inner = provider as unknown as {
      connections: Set<unknown>;
      receive(connection: unknown, chunk: Uint8Array): void;
    };
    inner.connections.add(connection);
    const send = (frame: object): void => {
      inner.receive(connection, Buffer.from(`${JSON.stringify(frame)}\n`));
    };
    send({
      t: "hello",
      sessionId: "s1",
      provider: "omp",
      title: "Eva",
      projectPath: "/p",
      status: "working",
      lastActivity: "",
      lastActivityAt: 1,
      canRespond: true,
    });
    const calls = new AgentCalls();
    const row = calls.row("m1", "t1", "write", xd("agents_ask", ask), 5);
    send({ t: "messages", append: [row] });
    calls.result({
      toolCallId: "t1",
      content: [{ type: "text", text: done("run-1") }],
      isError: false,
    });
    send({ t: "message.agent", id: row.id, text: row.text, agentTool: row.agentTool });
    const appended = changes.find((change) => change.kind === "conversation");
    expect(appended?.kind === "conversation" ? appended.appended[0] : undefined).toMatchObject({
      id: "m1",
      agentRun: { status: "running", startedAt: 5 },
    });
    expect(appended?.kind === "conversation" ? appended.appended[0] : undefined).not.toHaveProperty(
      "agentTool",
    );
    expect(changes.at(-1)).toMatchObject({
      kind: "agentRun",
      sessionId: "s1",
      id: "m1",
      text: row.text,
      agentRun: { run: "run-1", status: "done" },
    });
  });
});

describe("agents runs in an assistant thread", () => {
  const thread = (lines: string[]) =>
    toAssistantMessages(rows(lines), null, "[From Eva's background jobs] ");

  it("shows a running specialist on a status row until the turn replies, then on the reply", () => {
    const asked = thread([user("find an SSD", 1), call("t1", "agents_ask", ask, 2)]);
    expect(asked.map((m) => m.role)).toEqual(["user", "status"]);
    expect(asked[1]).toMatchObject({
      role: "status",
      agents: [{ agent: "web-researcher", status: "running" }],
    });
    expect(asked[1]?.text).toMatch(/^Web researcher is on it · \d+:\d\d$/);
    const replied = thread([
      user("find an SSD", 1),
      call("t1", "agents_ask", ask, 2),
      result("t1", done("run-1"), 30),
      said("Get the Acasis.", 31),
    ]);
    expect(replied.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(replied[1]?.agents).toEqual([
      expect.objectContaining({ run: "run-1", status: "done", sources: 1 }),
    ]);
  });

  it("folds an ask that came back running with the agents_result that finished it", () => {
    const out = thread([
      user("dig deeper", 1),
      call("t1", "agents_ask", ask, 2),
      result("t1", running("run-9"), 3),
      said("Still digging.", 4),
      call("t2", "agents_result", { run: "run-9" }, 5),
      result("t2", done("run-9", "web-researcher", 120), 125),
      said("Found it.", 126),
    ]);
    expect(out.map((m) => [m.role, m.text])).toEqual([
      ["user", "dig deeper"],
      ["assistant", "Still digging."],
      ["assistant", "Found it."],
    ]);
    expect(out[1]?.agents).toBeUndefined();
    expect(out[2]?.agents).toEqual([
      expect.objectContaining({ run: "run-9", status: "done", seconds: 120 }),
    ]);
  });

  it("lists several specialists of one turn on its reply, and each turn's own", () => {
    const out = thread([
      user("plan the launch", 1),
      call("t1", "agents_ask", ask, 2),
      call(
        "t2",
        "agents_ask",
        { agent: "design-critic", request: { url: "https://x.example" } },
        2,
      ),
      result("t1", done("run-1"), 30),
      result("t2", JSON.stringify({ error: "no such agent" }), 31, true),
      said("Here is the plan.", 32),
      user("thanks", 40),
      said("Any time.", 41),
    ]);
    expect(out[1]?.agents?.map((run) => [run.agent, run.status])).toEqual([
      ["web-researcher", "done"],
      ["design-critic", "failed"],
    ]);
    expect(out[1]?.agents?.[1]?.error).toBe("no such agent");
    expect(out[3]?.agents).toBeUndefined();
  });
});
