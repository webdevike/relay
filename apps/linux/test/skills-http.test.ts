import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { afterEach, describe, expect, it } from "vitest";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { CanvasPeer } from "../src/canvas/room";
import { SkillCatalog } from "../src/skills/catalog";
import { DOC_KEYS } from "../src/skills/doc";
import { authorizeSkillSocket, handleSkillsRequest } from "../src/skills/http";
import { SkillRoom } from "../src/skills/room";
import { SkillsService } from "../src/skills/service";
import { SkillUsageIndex } from "../src/skills/usage";
import { type SkillsHome, skillsHome, skillText } from "./skills-home";

const homes: SkillsHome[] = [];
const services: SkillsService[] = [];

async function setup(): Promise<{ home: SkillsHome; skills: SkillsService }> {
  const home = skillsHome();
  homes.push(home);
  const now = Date.now();
  home.write(
    ".omp/profiles/personal/agent/sessions/-Eva/s.jsonl",
    `${JSON.stringify({ type: "message", timestamp: new Date(now - 60_000).toISOString(), message: { content: [{ type: "toolCall", arguments: { path: "skill://alpha" } }] } })}\n`,
  );
  const usage = new SkillUsageIndex({ home: home.home });
  await usage.refresh();
  const skills = new SkillsService({
    catalog: new SkillCatalog({ home: home.home, evaRoot: home.evaRoot, run: home.run }),
    usage,
    room: { pacing: { selectMs: 0, typeMs: 0 }, watch: false },
  });
  services.push(skills);
  return { home, skills };
}

afterEach(() => {
  for (const skills of services.splice(0)) skills.stop();
  for (const home of homes.splice(0)) home.cleanup();
});

const LOCAL = "127.0.0.1";

function call(skills: SkillsService | null, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; remote?: string } = {}): Promise<Response> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const headers = init.headers ?? (method === "GET" ? {} : { "content-type": "application/json" });
  const request = new Request(`http://h${path}`, { method, headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  return handleSkillsRequest(skills, request, path, init.remote ?? LOCAL);
}

describe("skills http", () => {
  it("refuses non-loopback callers, browser writes and non-JSON writes", async () => {
    const { skills } = await setup();
    expect((await call(skills, "/skills", { remote: "100.64.0.2" })).status).toBe(403);
    expect((await call(skills, "/skills", { remote: "::1" })).status).toBe(200);
    expect((await call(skills, "/skills/alpha/save", { body: {}, headers: { "content-type": "application/json", origin: "https://evil.example" } })).status).toBe(403);
    expect((await call(skills, "/skills/alpha/save", { body: {}, headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await call(null, "/skills")).status).toBe(404);
    expect((await call(skills, "/skills", { method: "DELETE", headers: { "content-type": "application/json" } })).status).toBe(405);
  });

  it("lists skills with usage and answers one skill's detail", async () => {
    const { skills } = await setup();
    const list = (await (await call(skills, "/skills")).json()) as { skills: { name: string; lastUsedAt: number | null; usedBy: string[] }[]; assistants: { id: string }[] };
    expect(list.skills.map((row) => row.name)).toEqual(["alpha", "beta", "delta", "eps", "gamma"]);
    expect(list.skills[0]?.lastUsedAt).toEqual(expect.any(Number));
    expect(list.skills[1]?.lastUsedAt).toBeNull();
    expect(list.assistants.map((assistant) => assistant.id)).toEqual(["nova", "polaris", "astra", "dflt"]);
    const detail = (await (await call(skills, "/skills/alpha")).json()) as Record<string, unknown>;
    expect(detail).toMatchObject({
      name: "alpha",
      files: [{ path: "SKILL.md" }, { path: "refs/guide.md", size: 6 }],
      usage: { lastUsedBy: "Nova, Polaris", loads30d: 1 },
      profiles: { nova: "personal", polaris: "personal", astra: "work", dflt: null },
    });
    expect((await call(skills, "/skills/nope")).status).toBe(404);
    expect((await call(skills, "/skills/Bad%20Name")).status).toBe(404);
  });

  it("switches access through the runner and answers the row", async () => {
    const { home, skills } = await setup();
    const response = await call(skills, "/skills/alpha/access", { body: { enabled: { nova: true } } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "alpha", source: { key: "eva" } });
    expect(home.calls).toEqual([["--profile", "personal", "config", "set", "disabledExtensions", "[]"]]);
    expect((await call(skills, "/skills/alpha/access", { body: { enabled: { nova: "yes" } } })).status).toBe(400);
  });

  it("opens a room whose token alone admits its websocket", async () => {
    const { skills } = await setup();
    const opened = (await (await call(skills, "/skills/alpha/open", { body: { user: { name: "Isaac", color: "#0ea5e9" } } })).json()) as { token: string; path: string };
    expect(opened.path).toBe("/skills/alpha");
    const ws = (name: string, token: string, remote = LOCAL): SkillRoom | Response | null =>
      authorizeSkillSocket(skills, new Request(`http://h/skills/${name}/ws?token=${token}`), `/skills/${name}/ws`, remote);
    expect(ws("alpha", opened.token)).toBeInstanceOf(SkillRoom);
    expect(ws("alpha", "nope")).toMatchObject({ status: 401 });
    expect(ws("gamma", opened.token)).toMatchObject({ status: 401 });
    expect(ws("alpha", opened.token, "100.64.0.2")).toMatchObject({ status: 403 });
    expect(authorizeSkillSocket(null, new Request("http://h/skills/alpha/ws"), "/skills/alpha/ws", LOCAL)).toMatchObject({ status: 401 });
    expect(authorizeSkillSocket(skills, new Request("http://h/skills/alpha"), "/skills/alpha", LOCAL)).toBeNull();
  });

  it("syncs the room's doc to a websocket peer over the y-websocket protocol", async () => {
    const { skills } = await setup();
    const { token } = skills.open("alpha");
    const room = skills.authorize("alpha", token);
    if (room === null) throw new Error("no room");
    const client = new Y.Doc();
    const peer: CanvasPeer = {
      send: (data) => {
        const decoder = decoding.createDecoder(data);
        if (decoding.readVarUint(decoder) !== 0) return;
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, 0);
        syncProtocol.readSyncMessage(decoder, reply, client, "host");
        if (encoding.length(reply) > 1) room.sync.receive(peer, encoding.toUint8Array(reply));
      },
      close: () => undefined,
    };
    skills.connect(room, peer);
    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, 0);
    syncProtocol.writeSyncStep1(step1, client);
    room.sync.receive(peer, encoding.toUint8Array(step1));
    await Promise.resolve();
    expect(client.getMap(DOC_KEYS.front).toJSON()).toEqual({ name: "alpha", description: "Alpha skill" });
    expect(client.getXmlFragment(DOC_KEYS.body).length).toBe(2);
    skills.disconnect(room, peer);
    expect(room.sync.peerCount).toBe(0);
  });

  it("edits as an agent, saves, refuses a save over an outside change, reloads and leaves", async () => {
    const { home, skills } = await setup();
    const file = join(home.evaRoot, ".omp/skills/alpha/SKILL.md");
    const edited = await call(skills, "/skills/alpha/edit", { body: { as: "Nova", find: "Body of alpha", replace: "Body of Alpha" } });
    expect(await edited.json()).toEqual({ ok: true, dirty: true, saved: false });
    const saved = (await (await call(skills, "/skills/alpha/save", { body: {} })).json()) as { saved: boolean; savedAt: number };
    expect(saved).toEqual({ saved: true, savedAt: expect.any(Number) as unknown });
    expect(await call(skills, "/skills/alpha/edit", { body: { as: "Nova", find: "Body of Alpha", replace: "Body of alpha" } }).then((r) => r.status)).toBe(200);
    writeFileSync(file, skillText("alpha", "Changed elsewhere"));
    const refused = await call(skills, "/skills/alpha/save", { body: {} });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "changed-on-disk" });
    expect(await (await call(skills, "/skills/alpha/reload", { body: {} })).json()).toEqual({ reloaded: true });
    expect(skills.room("alpha").text()).toBe(skillText("alpha", "Changed elsewhere"));
    expect(await (await call(skills, "/skills/alpha/leave", { body: { as: "Nova" } })).json()).toEqual({ ok: true });
    expect(skills.room("alpha").agentCount).toBe(0);
    expect((await call(skills, "/skills/alpha/edit", { body: { as: "Nova", find: "a", replace: "b", markdown: "x" } })).status).toBe(400);
    expect((await call(skills, "/skills/alpha/edit", { body: { as: "Nova", find: "nowhere", replace: "b" } })).status).toBe(422);
    expect((await call(skills, "/skills/nope/save", { body: {} })).status).toBe(404);
  });

  it("unloads rooms nobody uses", async () => {
    let now = Date.now();
    const { home } = await setup();
    const skills = new SkillsService({
      catalog: new SkillCatalog({ home: home.home, evaRoot: home.evaRoot, run: home.run }),
      usage: new SkillUsageIndex({ home: home.home }),
      now: () => now,
      room: { watch: false },
    });
    services.push(skills);
    const first = skills.room("alpha");
    now += 5 * 60_000;
    skills.sweep();
    expect(skills.room("alpha")).not.toBe(first);
  });
});
