import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { AgentSession, CanvasEntry } from "@relay/protocol";
import { boardText, exportBoard, nodesOf, parseBoard } from "@relay/canvas-live/board";
import { DOC_KEYS, type ChatMsg, type Presence } from "@relay/canvas-live/shared";
import { OmpBridgeProvider } from "../src/agents/bridge";
import { parseSessionRows } from "../src/agents/transcript";
import { toAssistantMessages } from "../src/assistant/service";
import type { CanvasBrain } from "../src/canvas/brain";
import { callerFile, chatFileOf, detectCaller, subagentName } from "../src/canvas/caller";
import { authorizeCanvasSocket, handleCanvasRequest } from "../src/canvas/http";
import { BoardFile } from "../src/canvas/persist";
import type { CanvasPeer } from "../src/canvas/room";
import { CanvasError, CanvasService, type CanvasChats, type CanvasRoom } from "../src/canvas/service";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "packages", "canvas-live", "test", "fixtures");

/**
 * Waits for a condition, not a duration. The polling tick is real time because what is awaited is
 * real: fs watch events, and the agent's turn loop chaining microtasks and zero-delay timers.
 */
async function until(check: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A scripted model: answers by what the prompt asks for, streamed in small chunks. */
class FakeBrain implements CanvasBrain {
  readonly ready = Promise.resolve();
  readonly prompts: string[] = [];
  disposed = false;

  constructor(
    readonly system: string,
    private readonly answer: (message: string) => string,
  ) {}

  async run(message: string, onDelta: (delta: string) => void): Promise<void> {
    this.prompts.push(message);
    const out = this.answer(message);
    for (let i = 0; i < out.length; i += 7) {
      onDelta(out.slice(i, i + 7));
      await Promise.resolve();
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}

function answer(message: string): string {
  if (message.includes("# Session start")) return "@say Last time we mapped the roles. Open questions go on the left.\n@add_node agenda note -900 0 480\nAgenda\n1 · Is support staff?\n@end\n@say First one: is support staff?\n";
  if (message.includes("# Session end")) return "We renamed the root and settled that support is staff. Still open: ops.";
  return "@say Done, renamed it.\n@set_text root title\nECS roles, renamed live\n@end\n";
}

/** A browser tab speaking the y-websocket protocol to a room, through a `CanvasPeer`. */
function joinRoom(service: CanvasService, room: CanvasRoom, name: string): { doc: Y.Doc; awareness: awarenessProtocol.Awareness; leave: () => void } {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const frame = (type: number, write: (e: encoding.Encoder) => void): Uint8Array => {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, type);
    write(e);
    return encoding.toUint8Array(e);
  };
  const peer: CanvasPeer = {
    send: (data) => {
      const decoder = decoding.createDecoder(data);
      const type = decoding.readVarUint(decoder);
      if (type === 0) {
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, 0);
        syncProtocol.readSyncMessage(decoder, reply, doc, "remote");
        if (encoding.length(reply) > 1) room.sync.receive(peer, encoding.toUint8Array(reply));
      } else if (type === 1) {
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), "remote");
      }
    },
    close: () => undefined,
  };
  service.connect(room, peer);
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "remote") room.sync.receive(peer, frame(0, (e) => { syncProtocol.writeUpdate(e, update); }));
  });
  awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin !== "remote") room.sync.receive(peer, frame(1, (e) => { encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed])); }));
  });
  room.sync.receive(peer, frame(0, (e) => { syncProtocol.writeSyncStep1(e, doc); }));
  awareness.setLocalState({ user: { name, color: "#0ea5e9", kind: "human" }, cursor: null, selected: [] } satisfies Presence);
  return {
    doc,
    awareness,
    leave: () => {
      awareness.destroy();
      service.disconnect(room, peer);
    },
  };
}

const session = (id: string, extra: Partial<AgentSession> = {}): AgentSession => ({ id, provider: "omp", title: "Fix login", projectPath: "/Users/ike/Eva", status: "working", lastActivity: "", lastActivityAt: 1, canRespond: true, ...extra });
const turnLine = (role: "user" | "assistant", text: string): string => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });

let root: string;
let canvasDir: string;
let chatFile: string;
let subagentFile: string;
let novaFile: string;
let posted: { sessionId: string; content: string; details: CanvasEntry }[];
let brains: FakeBrain[];
let chats: CanvasChats;
let service: CanvasService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "relay-canvas-"));
  canvasDir = join(root, "canvases");
  mkdirSync(canvasDir);
  for (const name of ["ecs-roles.json", "platform-assets-filters.json"]) copyFileSync(join(FIXTURES, name), join(canvasDir, name));
  const sessions = join(root, "sessions");
  chatFile = join(sessions, "2026-10-28T00-00-00-000Z_chat.jsonl");
  subagentFile = join(sessions, "2026-10-28T00-00-00-000Z_chat", "Build", "Build.Worker.jsonl");
  novaFile = join(sessions, "nova.jsonl");
  mkdirSync(dirname(subagentFile), { recursive: true });
  writeFileSync(chatFile, `${[turnLine("user", "Let's go over the ECS roles board"), turnLine("assistant", "Opening a live canvas on it now.")].join("\n")}\n`);
  writeFileSync(join(sessions, "2026-10-28T00-00-00-000Z_chat", "Build.jsonl"), `${turnLine("user", "Build the thing")}\n`);
  writeFileSync(subagentFile, `${turnLine("user", "Worker assignment: review the roles board with Isaac")}\n`);
  writeFileSync(novaFile, `${turnLine("user", "Nova, plan the week on a board")}\n`);
  writeFileSync(join(root, "nova.png"), "png");
  posted = [];
  brains = [];
  const live = [session("s-chat"), session("s-nova", { kind: "assistant", assistant: "nova", title: "Nova" })];
  const files: Record<string, string> = { "s-chat": chatFile, "s-nova": novaFile };
  chats = {
    sessions: live,
    sessionForFile: (file) => live.find((s) => files[s.id] === file) ?? null,
    sessionFile: (id) => files[id] ?? null,
    canvas: (sessionId, content, details) => {
      posted.push({ sessionId, content, details });
      return Promise.resolve(true);
    },
  };
  service = new CanvasService({
    canvasDir,
    chats,
    registry: [{ id: "nova", title: "Nova", avatar: "nova-17", portrait: { style: "micah", seed: "nova-17", colors: { accent: "#f76707" } } }],
    avatarsDir: root,
    brains: (system) => {
      const brain = new FakeBrain(system, answer);
      brains.push(brain);
      return brain;
    },
    log: () => undefined,
    watch: false,
    pacing: { frameMs: 0, typeMs: 0 },
    participants: { paceMs: 0 },
  });
});

afterEach(() => {
  service.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("board file", () => {
  it("seeds without rewriting, writes doc edits, and merges an outside write", async () => {
    const path = join(canvasDir, "ecs-roles.json");
    const original = readFileSync(path, "utf8");
    const doc = new Y.Doc();
    const file = new BoardFile(canvasDir, "ecs-roles", doc, () => undefined);
    expect(file.open("unused")).toEqual({ created: false });
    file.flush();
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(boardText(exportBoard(doc))).toBe(original);

    (nodesOf(doc).get("root")?.get("title") as Y.Text).insert(0, "Live: ");
    file.flush();
    const written = parseBoard(readFileSync(path, "utf8"));
    expect(written.nodes.find((n) => n.id === "root")?.data?.title).toBe("Live: ECS roles → what they unlock");
    expect(readFileSync(path, "utf8")).toBe(boardText(exportBoard(doc)));

    // Someone else writes the file (an agent editing JSON): the watcher merges it into the doc.
    file.close();
    const watched = new Y.Doc();
    const live = new BoardFile(canvasDir, "ecs-roles", watched, () => undefined);
    live.open("unused");
    const outside = parseBoard(readFileSync(path, "utf8"));
    outside.title = "Retitled outside";
    outside.nodes.push({ id: "from-agent", type: "note", x: 0, y: 900, data: { body: "added by a script" } });
    writeFileSync(path, JSON.stringify(outside, null, 2));
    await until(() => nodesOf(watched).has("from-agent"), "the outside write to reach the doc");
    expect(watched.getMap(DOC_KEYS.meta).get("title")).toBe("Retitled outside");
    live.close();
  });

  it("creates a new board file", () => {
    const doc = new Y.Doc();
    const file = new BoardFile(canvasDir, "fresh", doc, () => undefined);
    expect(file.open("Fresh ideas", { watch: false })).toEqual({ created: true });
    expect(readFileSync(join(canvasDir, "fresh.json"), "utf8")).toBe('{\n  "version": 1,\n  "title": "Fresh ideas",\n  "nodes": [],\n  "edges": []\n}\n');
    file.close();
  });
});

describe("caller", () => {
  it("takes the newest open transcript as the caller and walks up to its chat", () => {
    expect(chatFileOf(subagentFile)).toBe(chatFile);
    expect(chatFileOf(chatFile)).toBe(chatFile);
    expect(subagentName(subagentFile)).toBe("Worker");
    const mtimes: Record<string, number> = { [chatFile]: 1, [subagentFile]: 5 };
    expect(callerFile([chatFile, subagentFile, "/tmp/other.log"], (f) => mtimes[f] ?? 0)).toBe(subagentFile);
    const caller = detectCaller({
      env: { RELAY_ASSISTANT: "nova" },
      ancestors: () => [
        { pid: 10, args: "bash -c relay-linux canvas start" },
        { pid: 9, args: "/Users/ike/.local/bin/omp --profile personal" },
      ],
      openFiles: (pid) => (pid === 9 ? [chatFile, subagentFile] : []),
      mtime: (f) => mtimes[f] ?? 0,
      exists: (f) => f === chatFile || f.endsWith("Build.jsonl"),
    });
    expect(caller).toMatchObject({ sessionFile: subagentFile, chatFile, assistant: "nova" });
  });
});

describe("starting a session", () => {
  it("from a manual chat: the room is Eva's and the Join card goes to that chat", async () => {
    const started = await service.start({ slug: "ecs-roles", prompt: "Settle who is staff", caller: { sessionFile: chatFile } });
    expect(started).toMatchObject({ slug: "ecs-roles", board: "ECS roles → functionality", agent: { name: "Eva" }, chat: { sessionId: "s-chat", title: "Fix login" }, created: true, joinPath: "/canvas/ecs-roles/" });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ sessionId: "s-chat", details: { kind: "start", slug: "ecs-roles", roomId: started.roomId, agent: { name: "Eva" }, text: "Settle who is staff" } });
    expect(posted[0]?.content).toContain("Isaac has a Join card");
    // The brain carries the chat, and the opener is already being generated.
    expect(brains[0]?.system).toContain("Isaac: Let's go over the ECS roles board");
    expect(brains[0]?.system).toContain("Settle who is staff");
    await until(() => brains[0]?.prompts.some((p) => p.includes("# Session start")) === true, "the precomputed opener");
    expect(service.snapshot().rooms).toMatchObject([{ slug: "ecs-roles", live: true, chat: { sessionId: "s-chat" } }]);
    // Starting again from the same chat rejoins; another chat is refused.
    expect((await service.start({ slug: "ecs-roles", caller: { sessionFile: chatFile } })).created).toBe(false);
    await expect(service.start({ slug: "ecs-roles", caller: { assistant: "nova" } })).rejects.toThrow(CanvasError);
  });

  it("from an assistant thread: the agent is that assistant, with its accent and avatar", async () => {
    const started = await service.start({ slug: "platform-assets-filters", caller: { sessionFile: novaFile } });
    expect(started.agent).toEqual({ name: "Nova", color: "#f76707", avatar: "/canvas/avatar/nova" });
    expect(posted[0]).toMatchObject({ sessionId: "s-nova", details: { kind: "start", agent: { name: "Nova" } } });
    expect(started.chat).toEqual({ sessionId: "s-nova", assistant: "nova", title: "Nova" });
    expect(brains[0]?.system).toContain("You are Nova");
    service.stop();
    // By assistant id alone (Relay Desktop's relay-ctl), on a new board.
    const fresh = await service.start({ title: "Week plan", caller: { assistant: "nova" } });
    expect(fresh).toMatchObject({ slug: "week-plan", board: "Week plan", agent: { name: "Nova" }, created: true });
    expect(readFileSync(join(canvasDir, "week-plan.json"), "utf8")).toContain('"title": "Week plan"');
  });

  it("from a subagent: the canvas self is still the chat's agent, with the chat as context", async () => {
    // The CLI cannot tell a subagent's call from its parent's (one omp process holds both
    // transcripts open), so the room is the chat's; subagents take a cursor with `canvas join`.
    const started = await service.start({ slug: "ecs-roles", caller: { sessionFile: subagentFile } });
    expect(started.agent.name).toBe("Eva");
    expect(started.chat.sessionId).toBe("s-chat");
    expect(posted[0]).toMatchObject({ sessionId: "s-chat", details: { kind: "start", agent: { name: "Eva" } } });
    expect(posted[0]?.content).toContain("canvas join ecs-roles --as <Name>");
    expect(brains[0]?.system).toContain("Let's go over the ECS roles board");
    expect(brains[0]?.system).not.toContain("Worker assignment");
  });

  it("refuses a chat Relay does not know", async () => {
    const stray = join(root, "stray.jsonl");
    writeFileSync(stray, "");
    await expect(service.start({ slug: "ecs-roles", caller: { sessionFile: stray } })).rejects.toMatchObject({ status: 409 });
    await expect(service.start({ slug: "Bad Slug", caller: { sessionFile: chatFile } })).rejects.toMatchObject({ status: 400 });
    expect(posted).toHaveLength(0);
  });
});

describe("a session at the canvas", () => {
  it("opens on join, answers a note with edits and a turn row, and wraps up into an end row", async () => {
    const started = await service.start({ slug: "ecs-roles", caller: { sessionFile: chatFile } });
    const room = service.roomById(started.roomId);
    if (room === undefined) throw new Error("no room");
    const tab = joinRoom(service, room, "Isaac");
    await until(() => tab.doc.getMap(DOC_KEYS.nodes).has("agenda"), "the opener's agenda note");
    expect(service.snapshot().rooms[0]?.humans).toEqual(["Isaac"]);
    const agent = [...tab.awareness.getStates().values()].find((p) => (p as Presence).user.kind === "agent") as Presence | undefined;
    expect(agent?.user.name).toBe("Eva");

    const note: ChatMsg = { id: "n1", kind: "human", name: "Isaac", color: "#0ea5e9", text: "rename the root", nodeIds: ["root"], at: null, ts: Date.now() };
    tab.doc.getArray<ChatMsg>(DOC_KEYS.chat).push([note]);
    await until(() => posted.some((p) => p.details.kind === "turn"), "the turn row");
    const turn = posted.find((p) => p.details.kind === "turn");
    expect(turn).toMatchObject({ sessionId: "s-chat", details: { kind: "turn", human: { name: "Isaac", text: "rename the root" }, text: "Done, renamed it." } });
    expect(turn?.content).toContain("Isaac: rename the root");
    expect((tab.doc.getMap<Y.Map<unknown>>(DOC_KEYS.nodes).get("root")?.get("title") as Y.Text).toJSON()).toBe("ECS roles, renamed live");
    const metrics = room.sync.doc.getMap(DOC_KEYS.metrics).get("s:n1") as { cursor: number; firstToken: number } | undefined;
    expect(metrics?.cursor).toBeLessThan(300);

    // Wrap up from the page's button: summary to the chat, the room ends, the board is on disk.
    const access = service.open("ecs-roles", "phone-1");
    if (access.t !== "canvas.access") throw new Error("expected access");
    const res = await handleCanvasRequest(service, () => "", new Request(`http://h/canvas/ecs-roles/end?token=${access.token}`, { method: "POST" }), "/canvas/ecs-roles/end", "100.64.0.2");
    expect(await res.json()).toEqual({ summary: "We renamed the root and settled that support is staff. Still open: ops." });
    expect(posted.at(-1)).toMatchObject({ sessionId: "s-chat", details: { kind: "end", text: "We renamed the root and settled that support is staff. Still open: ops." } });
    expect(brains.every((b) => b.disposed)).toBe(true);
    const onDisk = parseBoard(readFileSync(join(canvasDir, "ecs-roles.json"), "utf8"));
    expect(onDisk.nodes.find((n) => n.id === "root")?.data?.title).toBe("ECS roles, renamed live");
    expect(onDisk.nodes.some((n) => n.id === "agenda")).toBe(true);
    expect(service.open("ecs-roles", "phone-1")).toMatchObject({ t: "canvas.unavailable" });
    expect((room.sync.doc.getMap(DOC_KEYS.meta).get("session") as { open: boolean }).open).toBe(false);
    tab.leave();
    expect(service.snapshot().rooms).toMatchObject([{ slug: "ecs-roles", live: false }]);
  });
});

describe("agents joining a live room", () => {
  const act = (slug: string, id: string, script: string): Promise<Response> =>
    handleCanvasRequest(service, () => "", new Request(`http://h/canvas/sessions/${slug}/participants/${id}/act`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script }) }), `/canvas/sessions/${slug}/participants/${id}/act`, "127.0.0.1");

  it("gives each joined agent its own cursor and attributed edits, merged into one board on disk", async () => {
    const started = await service.start({ slug: "ecs-roles", caller: { sessionFile: chatFile } });
    const room = service.roomById(started.roomId);
    if (room === undefined) throw new Error("no room");
    const tab = joinRoom(service, room, "Isaac");
    await until(() => tab.doc.getMap(DOC_KEYS.nodes).has("agenda"), "the opener");

    const names = ["Theo", "Priya", "Sam"];
    const joined = names.map((name) => service.join("ecs-roles", { name, purpose: `${name}'s column` }));
    expect(new Set(joined.map((j) => j.participant.color)).size).toBe(3);
    expect(joined[0]?.participant).toMatchObject({ name: "Theo", avatar: "/canvas/portrait/theo" });
    expect(service.join("ecs-roles", { name: "theo" })).toMatchObject({ created: false, participant: { id: joined[0]?.participant.id } });
    expect(() => service.join("ecs-roles", { name: "Eva" })).toThrow(CanvasError);

    // All three act at once, each in its own column; one also edits a shared note.
    const image = join(root, "shot.png");
    writeFileSync(image, "png");
    const results = await Promise.all(
      joined.map(async (j, i) => {
        const x = 2000 + i * 600;
        const res = await act("ecs-roles", j.participant.id, [`@cursor ${String(x)} 0`, `@say ${j.participant.name} here`, `@add_image shot-${String(i)} ${String(x)} 0 480 ${image}`, `Shot ${String(i)}`, "what to look at", "@end", `@add_node note-${String(i)} note ${String(x)} 500 420`, `Note ${String(i)}`, `from ${j.participant.name}`, "@end", "@append_text agenda body", `${String(i + 2)} · ${j.participant.name}'s question`, "@end", "@add_edge nope root"].join("\n"));
        return (await res.json()) as { ran: number; said: string[]; skipped: string[] };
      }),
    );
    for (const result of results) expect(result).toEqual({ ran: 4, said: [expect.stringMatching(/here$/)], skipped: ["add_edge nope root: no node nope"] });

    const states = [...(tab.awareness.getStates() as Map<number, Presence>).values()];
    expect(states.filter((p) => p.user.kind === "agent").map((p) => p.user.name).sort()).toEqual(["Eva", "Priya", "Sam", "Theo"]);
    const nodes = tab.doc.getMap<Y.Map<unknown>>(DOC_KEYS.nodes);
    for (let i = 0; i < 3; i++) {
      expect(nodes.get(`shot-${String(i)}`)?.toJSON()).toMatchObject({ type: "image", src: image, caption: "what to look at" });
      expect((nodes.get(`note-${String(i)}`)?.get("body") as Y.Text).toJSON()).toBe(`from ${names[i] ?? ""}`);
    }
    // Concurrent appends to one note all land; none clobbers another.
    const agenda = (nodes.get("agenda")?.get("body") as Y.Text).toJSON();
    for (const name of names) expect(agenda).toContain(`${name}'s question`);
    const chat = tab.doc.getArray<ChatMsg>(DOC_KEYS.chat).toArray();
    expect(chat.filter((m) => m.kind === "agent" && names.includes(m.name)).map((m) => m.text).sort()).toEqual(["Priya here", "Sam here", "Theo here"]);
    expect(chat.some((m) => m.kind === "event" && m.text === "Theo joined: Theo's column")).toBe(true);
    // Their lines never start a turn of the canvas self: only the opener's prompt so far.
    expect(brains[0]?.prompts.filter((p) => !p.includes("# Session start"))).toEqual([]);

    // Leaving takes the cursor away at once.
    service.leave("ecs-roles", joined[2]?.participant.id ?? "");
    expect([...(tab.awareness.getStates() as Map<number, Presence>).values()].some((p) => p.user.name === "Sam")).toBe(false);
    expect((await act("ecs-roles", joined[2]?.participant.id ?? "", "@say still here?")).status).toBe(410);

    // The room ends: the wrap-up row names them, and the board on disk holds their work.
    await service.end(room.id);
    // Isaac said nothing, but the agents worked: the canvas self writes a real summary.
    expect(posted.at(-1)?.details.text).toBe("We renamed the root and settled that support is staff. Still open: ops.");
    expect(posted.at(-1)?.content).toContain("Agents who worked the board: Theo, Priya, Sam.");
    const onDisk = parseBoard(readFileSync(join(canvasDir, "ecs-roles.json"), "utf8"));
    expect(onDisk.nodes.filter((n) => /^(shot|note)-\d$/.test(n.id)).map((n) => n.id).sort()).toEqual(["note-0", "note-1", "note-2", "shot-0", "shot-1", "shot-2"]);
    expect(onDisk.nodes.find((n) => n.id === "shot-1")?.data).toMatchObject({ title: "Shot 1", src: image, caption: "what to look at" });
    expect(() => service.join("ecs-roles", { name: "Late" })).toThrow(/ended/);
    tab.leave();
  });

  it("queues each agent's batches, refuses a backlog, and caps the room", async () => {
    await service.start({ slug: "ecs-roles", caller: { sessionFile: chatFile } });
    const theo = service.join("ecs-roles", { name: "Theo" }).participant.id;
    const batches = [1, 2, 3, 4].map((n) => service.act("ecs-roles", theo, `@add_node q-${String(n)} note 3000 ${String(n * 300)} 400\nQ${String(n)}\n@end`));
    await expect(service.act("ecs-roles", theo, "@say one too many")).rejects.toMatchObject({ status: 429 });
    expect((await Promise.all(batches)).map((r) => r.ran)).toEqual([1, 1, 1, 1]);
    await expect(service.act("ecs-roles", theo, "no actions, just prose")).resolves.toMatchObject({ ran: 0, said: ["no actions, just prose"] });
    await expect(service.act("ecs-roles", theo, "   ")).rejects.toMatchObject({ status: 400 });
    await expect(service.act("ecs-roles", theo, "@add_frame col 2900 -100 600 1500\nTheo's column\n@end\n@add_image bad 0 0 400 /nope/missing.png\nx\n@end\n@add_image bad2 0 0 400 data:image/png;base64,AA\nx\n@end")).resolves.toEqual({
      ran: 1,
      said: [],
      skipped: ["add_image bad: no image file at /nope/missing.png", "add_image bad2: src must be an https URL or a local file path, not data:image/png;base64,AA"],
    });
    expect(service.view("ecs-roles").board.nodes.find((n) => n.id === "col")).toMatchObject({ type: "frame", x: 2900, y: -100, w: 600, h: 1500, data: { title: "Theo's column" } });
    for (let i = 1; i < 8; i++) service.join("ecs-roles", { name: `Agent ${String(i)}` });
    expect(() => service.join("ecs-roles", { name: "Ninth" })).toThrow(/8 agents/);
    expect(() => service.join("no-such-board", { name: "Theo" })).toThrow(/No live canvas session/);
  });
});

describe("canvas http", () => {
  it("gates the page, the room's routes and its websocket on the token", async () => {
    await service.start({ slug: "platform-assets-filters", caller: { sessionFile: chatFile } });
    const access = service.open("platform-assets-filters", "phone-1");
    if (access.t !== "canvas.access") throw new Error("expected access");
    expect(access.path).toBe(`/canvas/platform-assets-filters/?token=${encodeURIComponent(access.token)}`);
    const get = (path: string, query = ""): Promise<Response> => handleCanvasRequest(service, () => "<html>client</html>", new Request(`http://h${path}${query}`), path, "100.64.0.2");
    const base = "/canvas/platform-assets-filters";
    const page = await get(`${base}/`, `?token=${access.token}`);
    expect(await page.text()).toBe("<html>client</html>");
    expect((await get(`${base}/`, "?token=nope")).status).toBe(401);
    expect(await (await get(`${base}/me`, `?token=${access.token}`)).json()).toMatchObject({ me: { name: "Isaac" }, board: "Platform Assets filters", agent: { name: "Eva" }, live: true });
    expect((await get(`${base}/me`, "?token=nope")).status).toBe(401);
    // A token for one board opens no other.
    expect((await get("/canvas/ecs-roles/me", `?token=${access.token}`)).status).toBe(401);

    const ws = (token: string): CanvasRoom | Response | null => authorizeCanvasSocket(service, new Request(`http://h${base}/ws?token=${token}`), `${base}/ws`);
    expect((ws("nope") as Response).status).toBe(401);
    expect((ws(access.token) as CanvasRoom).slug).toBe("platform-assets-filters");
    expect(authorizeCanvasSocket(service, new Request("http://h/relay"), "/relay")).toBeNull();

    const src = parseBoard(readFileSync(join(canvasDir, "platform-assets-filters.json"), "utf8")).nodes.find((n) => n.data?.src !== undefined)?.data?.src ?? "";
    expect((await get(`${base}/img`, `?token=${access.token}&src=${encodeURIComponent(src)}`)).status).not.toBe(401);
    expect((await get(`${base}/img`, `?token=${access.token}&src=${encodeURIComponent("/etc/passwd")}`)).status).toBe(404);
    expect((await get(`${base}/img`, `?token=${access.token}&src=${encodeURIComponent("https://x.test/a.png")}`)).status).toBe(400);
    expect((await get("/canvas/avatar/nova")).status).toBe(200);
  });

  it("keeps the sessions API to loopback JSON without Origin", async () => {
    const post = (headers: Record<string, string>, remote = "127.0.0.1"): Promise<Response> =>
      handleCanvasRequest(service, () => "", new Request("http://h/canvas/sessions", { method: "POST", headers, body: JSON.stringify({ slug: "ecs-roles", caller: { sessionFile: chatFile } }) }), "/canvas/sessions", remote);
    expect((await post({ "content-type": "application/json" }, "100.64.0.2")).status).toBe(403);
    expect((await post({ "content-type": "application/json", origin: "http://evil.test" })).status).toBe(403);
    expect((await post({ "content-type": "text/plain" })).status).toBe(415);
    const ok = await post({ "content-type": "application/json" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ slug: "ecs-roles", created: true });
    const bad = await handleCanvasRequest(service, () => "", new Request("http://h/canvas/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caller: {} }) }), "/canvas/sessions", "127.0.0.1");
    expect(bad.status).toBe(400);
    const list = await handleCanvasRequest(service, () => "", new Request("http://h/canvas/sessions"), "/canvas/sessions", "127.0.0.1");
    expect(await list.json()).toMatchObject({ rooms: [{ slug: "ecs-roles", live: true }] });
  });
});

describe("canvas rows in chats", () => {
  const details: CanvasEntry = { kind: "start", roomId: "r1", slug: "ecs-roles", board: "ECS roles", agent: { name: "Nova", color: "#f76707", avatar: "/canvas/avatar/nova" }, text: "Settle staff roles" };
  const entry = JSON.stringify({ type: "custom_message", customType: "relay-canvas", content: "Live canvas started on ECS roles.", display: true, details, attribution: "agent", id: "x", parentId: "y", timestamp: "2026-10-28T05:00:00.000Z" });

  it("reads relay-canvas custom messages from a session file as canvas rows, and as cards for assistant threads", () => {
    let n = 0;
    const rows = parseSessionRows(`${turnLine("user", "hi")}\n${entry}\n${JSON.stringify({ type: "custom_message", customType: "eren", content: "x", display: true })}\n`, null, () => `r${String(++n)}`);
    expect(rows).toEqual([
      { id: "r1", role: "user", text: "hi", at: expect.any(Number) as number },
      { id: "r2", role: "system", text: "Live canvas started on ECS roles.", at: Date.parse("2026-10-28T05:00:00.000Z"), canvas: details },
    ]);
    const cards = toAssistantMessages(rows.slice(1), null, "[job]");
    expect(cards).toEqual([{ id: "r2", role: "card", text: "Live canvas started on ECS roles.", at: Date.parse("2026-10-28T05:00:00.000Z"), canvas: details }]);
  });

  it("asks the session's bridge to post the row, and passes the live row through to the phone", async () => {
    const provider = new OmpBridgeProvider("/unused.sock", () => undefined, null);
    const written: string[] = [];
    const connection = {
      socket: {
        write: (bytes: Uint8Array) => {
          written.push(Buffer.from(bytes).toString("utf8"));
          return bytes.length;
        },
        end: () => undefined,
      },
      buffer: "",
      outbound: null,
      session: null,
      sessionFile: null,
      pending: new Map(),
      gate: undefined,
    };
    const inner = provider as unknown as { connections: Set<unknown>; receive(connection: unknown, chunk: Uint8Array): void };
    inner.connections.add(connection);
    const send = (frame: object): void => {
      inner.receive(connection, Buffer.from(`${JSON.stringify(frame)}\n`));
    };
    send({ t: "hello", sessionId: "s1", provider: "omp", title: "Eva", projectPath: "/p", status: "working", lastActivity: "", lastActivityAt: 1, canRespond: true, sessionFile: chatFile });
    expect(provider.sessionForFile(chatFile)?.id).toBe("s1");

    const appended: unknown[] = [];
    provider.onChange = (change) => {
      if (change.kind === "conversation") appended.push(...change.appended);
    };
    const posting = provider.canvas("s1", "Live canvas started.", details);
    const request = JSON.parse(written.at(-1) ?? "{}") as { t: string; id: string; content: string; details: CanvasEntry };
    expect(request).toMatchObject({ t: "canvas", content: "Live canvas started.", details });
    send({ t: "result", id: request.id, ok: true, value: true });
    await expect(posting).resolves.toBe(true);

    send({ t: "messages", append: [{ id: "m1", role: "system", text: "Live canvas started.", at: 5, canvas: details }] });
    expect(appended).toEqual([{ id: "m1", role: "system", text: "Live canvas started.", at: 5, canvas: details }]);
  });
});
