import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acceptSuggestion, docThreadsOf, openDocThread, rejectSuggestion, snapDocThreads, snapSuggestions, textAnchor } from "@relay/canvas-live/doc-threads";
import { postInThread, type ThreadMsg } from "@relay/canvas-live/threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { SkillCatalog } from "../src/skills/catalog";
import { DOC_KEYS } from "../src/skills/doc";
import { handleSkillsRequest } from "../src/skills/http";
import type { SkillRoom } from "../src/skills/room";
import { SkillsService } from "../src/skills/service";
import { SkillUsageIndex } from "../src/skills/usage";
import { type SkillsHome, skillsHome } from "./skills-home";

const SKILL = `---
name: alpha
description: Alpha skill
---

# alpha

Read the **whole** diff before writing a single comment.

## Rules

- Keep every review comment under three sentences.
- Flag missing tests before style nits.
`;

const homes: SkillsHome[] = [];
const services: SkillsService[] = [];

afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  for (const h of homes.splice(0)) h.cleanup();
});

async function setup(deliver?: (assistant: string, text: string) => Promise<void>): Promise<{ home: SkillsHome; skills: SkillsService; file: string; threadsDir: string }> {
  const home = skillsHome();
  homes.push(home);
  const file = home.write("Eva/.omp/skills/alpha/SKILL.md", SKILL);
  const threadsDir = join(home.home, "skill-threads");
  const skills = new SkillsService({
    catalog: new SkillCatalog({ home: home.home, evaRoot: home.evaRoot, run: home.run, list: home.list }),
    usage: new SkillUsageIndex({ home: home.home, agentHome: home.evaRoot, assistantsDir: null, cacheFile: null, logFile: null }),
    room: { pacing: { selectMs: 0, typeMs: 0 }, watch: false },
    threadsDir,
    cli: "relay-linux",
    ...(deliver === undefined ? {} : { deliver }),
  });
  services.push(skills);
  await skills.refresh();
  return { home, skills, file, threadsDir };
}

/** An editor on `room`: its own doc, synced both ways as a websocket peer would be. */
function peerOf(room: SkillRoom): Y.Doc {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(room.sync.doc));
  peer.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "host") Y.applyUpdate(room.sync.doc, update, "peer");
  });
  room.sync.doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "peer") Y.applyUpdate(peer, update, "host");
  });
  return peer;
}

/** The text node containing `needle` in `doc`. */
function textWith(doc: Y.Doc, needle: string): Y.XmlText {
  const walk = (type: Y.XmlFragment | Y.XmlElement): Y.XmlText | null => {
    for (const child of type.toArray()) {
      if (child instanceof Y.XmlText && (child.toDelta() as { insert: string }[]).map((op) => op.insert).join("").includes(needle)) return child;
      if (child instanceof Y.XmlElement) {
        const found = walk(child);
        if (found !== null) return found;
      }
    }
    return null;
  };
  const found = walk(doc.getXmlFragment(DOC_KEYS.body));
  if (found === null) throw new Error(`no text with ${needle}`);
  return found;
}

const isaac = (id: string, text: string): ThreadMsg => ({ id, kind: "human", name: "Isaac", color: "#0ea5e9", text, ts: 1 });

/** Isaac comments `text` on `quote` from an editor. */
function comment(peer: Y.Doc, thread: string, quote: string, text: string): void {
  const node = textWith(peer, quote);
  const plain = (node.toDelta() as { insert: string }[]).map((op) => op.insert).join("");
  expect(openDocThread(docThreadsOf(peer), thread, textAnchor(node, plain.indexOf(quote), quote.length, quote), isaac(`m-${thread}`, text))).toBe(true);
}

const post = (skills: SkillsService, verb: string, body: unknown): Promise<Response> =>
  handleSkillsRequest(skills, new Request(`http://127.0.0.1/skills/alpha/${verb}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), `/skills/alpha/${verb}`, "127.0.0.1");

describe("skill comments", () => {
  it("hands Isaac's comment to Nova as a turn that says how to answer, and her reply lands in the thread", async () => {
    const deliver = vi.fn(() => Promise.resolve());
    const { skills, file } = await setup(deliver);
    const room = skills.room("alpha");
    const peer = peerOf(room);
    comment(peer, "t-1", "Flag missing tests", "Why tests first?");
    await vi.waitFor(() => {
      expect(deliver).toHaveBeenCalledTimes(1);
    });
    const [assistant, turn] = deliver.mock.calls[0] as unknown as [string, string];
    expect(assistant).toBe("nova");
    expect(turn).toContain("[Skill comment from Isaac] Why tests first?");
    expect(turn).toContain(`(Skill "alpha", ${file}, comment thread t-1 on the text "Flag missing tests".)`);
    expect(turn).toContain("relay-linux skills reply 'alpha' t-1 --as 'Nova' - <<'EOF'");
    expect(turn).toContain("relay-linux skills edit 'alpha' --as 'Nova' --thread t-1 --find");
    expect(snapDocThreads(docThreadsOf(peer))[0]?.assignee).toBe("nova");

    const reply = await post(skills, "reply", { as: "Nova", thread: "t-1", text: "Missing tests hide bugs; nits do not." });
    expect(reply.status).toBe(200);
    const [thread] = snapDocThreads(docThreadsOf(peer));
    expect(thread?.messages.at(-1)).toMatchObject({ kind: "agent", name: "Nova", avatar: "/canvas/avatar/nova", text: "Missing tests hide bugs; nits do not." });
    // Her own message is not a comment to route again.
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((await post(skills, "reply", { as: "Nova", thread: "t-404", text: "x" })).status).toBe(404);
  });

  it("routes to the assistant a comment @mentions, keeps it for the thread, and says so when it cannot be reached", async () => {
    const deliver = vi.fn((who: string) => (who === "astra" ? Promise.reject(new Error("Astra's thread is not running")) : Promise.resolve()));
    const { skills } = await setup(deliver);
    const room = skills.room("alpha");
    const peer = peerOf(room);
    comment(peer, "t-2", "Keep every review comment", "@Astra is this right?");
    await vi.waitFor(() => {
      expect(snapDocThreads(docThreadsOf(peer))[0]?.messages.at(-1)).toMatchObject({ kind: "agent", name: "Relay", text: "Could not reach Astra: Astra's thread is not running" });
    });
    expect(deliver.mock.calls.map((c) => c[0])).toEqual(["astra"]);
    peer.transact(() => postInThread(docThreadsOf(peer), "t-2", isaac("m-again", "Try again")));
    await vi.waitFor(() => {
      expect(deliver.mock.calls.map((c) => c[0])).toEqual(["astra", "astra"]);
    });
  });

  it("types a requested change as a suggestion: the file and dirty see none of it until accepted", async () => {
    const { skills, file } = await setup();
    const room = skills.room("alpha");
    const peer = peerOf(room);
    comment(peer, "t-3", "Keep every review comment under three sentences.", "Make this shorter");
    const result = await room.edit({ as: "Nova", thread: "t-3", find: "Keep every review comment under three sentences.", replace: "Three sentences per comment." });
    expect(result).toMatchObject({ ok: true, dirty: false, saved: false, suggestion: "s-t-3" });
    expect(textWith(peer, "Three sentences").toString()).toBe("Three sentences per comment.");
    const [suggestion] = snapSuggestions(peer);
    expect(suggestion).toMatchObject({ thread: "t-3", by: { name: "Nova", avatar: "/canvas/avatar/nova" } });
    expect(suggestion?.hunks[0]?.removed).toEqual([{ insert: "Keep every review comment under three sentences." }]);
    // The thread moved onto the new text, since its own text went.
    expect(snapDocThreads(docThreadsOf(peer))[0]?.anchor?.quote).toBe("Three sentences per comment.");
    // Not an unsaved edit, and a save writes the file as it was.
    expect(room.text()).toBe(SKILL);
    room.save();
    expect(readFileSync(file, "utf8")).toBe(SKILL);
    expect(room.idle(Date.now() + 3_600_000)).toBe(false);

    peer.transact(() => rejectSuggestion(peer, "s-t-3"), "editor");
    room.recompute();
    expect(room.dirty).toBe(false);
    expect(snapDocThreads(docThreadsOf(peer))[0]?.anchor?.quote).toBe("Keep every review comment under three sentences.");
    expect(room.text()).toBe(SKILL);

    await room.edit({ as: "Nova", thread: "t-3", find: "Keep every review comment under three sentences.", replace: "Three sentences per comment." });
    peer.transact(() => acceptSuggestion(peer, "s-t-3"), "editor");
    room.recompute();
    expect(room.dirty).toBe(true);
    room.save();
    expect(readFileSync(file, "utf8")).toBe(SKILL.replace("Keep every review comment under three sentences.", "Three sentences per comment."));
  });

  it("keeps marks around a replaced run and puts the original back exactly on reject", async () => {
    const { skills } = await setup();
    const room = skills.room("alpha");
    const peer = peerOf(room);
    comment(peer, "t-4", "whole diff", "Say all of it");
    const before = textWith(peer, "before writing").toDelta() as unknown;
    await room.edit({ as: "Nova", thread: "t-4", find: "whole diff", replace: "entire change" });
    peer.transact(() => rejectSuggestion(peer, "s-t-4"), "editor");
    expect(textWith(peer, "before writing").toDelta()).toEqual(before);
  });

  it("adds blocks after a list item's text as items of that list, typed in, as a suggestion", async () => {
    const { skills, file } = await setup();
    const room = skills.room("alpha");
    const peer = peerOf(room);
    comment(peer, "t-5", "Flag missing tests", "Add a rule about CI");
    await room.edit({ as: "Nova", thread: "t-5", after: "Flag missing tests", insert: "- Approve only when **CI** is green." });
    const list = peer.getXmlFragment(DOC_KEYS.body).toArray().find((el) => el instanceof Y.XmlElement && el.nodeName === "bulletList") as Y.XmlElement;
    expect(list.length).toBe(3);
    expect(snapSuggestions(peer)[0]?.hunks[0]?.kind).toBe("blocks");
    expect(room.text()).toBe(SKILL);
    peer.transact(() => acceptSuggestion(peer, "s-t-5"), "editor");
    room.save();
    expect(readFileSync(file, "utf8")).toBe(SKILL.replace("style nits.\n", "style nits.\n- Approve only when **CI** is green.\n"));
  });

  it("adds blocks after a paragraph at the top level, and reject takes them out", async () => {
    const { skills } = await setup();
    const room = skills.room("alpha");
    const peer = peerOf(room);
    comment(peer, "t-6", "before writing", "Add a note");
    const blocks = peer.getXmlFragment(DOC_KEYS.body).length;
    await room.edit({ as: "Nova", thread: "t-6", after: "before writing", insert: "Then read the tests." });
    expect(peer.getXmlFragment(DOC_KEYS.body).length).toBe(blocks + 1);
    expect(textWith(peer, "Then read the tests.").parent).toBe(peer.getXmlFragment(DOC_KEYS.body).get(2));
    peer.transact(() => rejectSuggestion(peer, "s-t-6"), "editor");
    expect(peer.getXmlFragment(DOC_KEYS.body).length).toBe(blocks);
    expect(room.text()).toBe(SKILL);
  });

  it("refuses a rewrite as a suggestion and an unknown thread", async () => {
    const { skills } = await setup();
    expect((await post(skills, "edit", { as: "Nova", thread: "t-1", markdown: "x" })).status).toBe(400);
    expect((await post(skills, "edit", { as: "Nova", thread: "t-nope", find: "Flag", replace: "x" })).status).toBe(404);
    expect((await post(skills, "edit", { as: "Nova", after: "Flag" })).status).toBe(400);
  });

  it("persists threads beside the skill and finds their text again when the skill opens fresh", async () => {
    const { home, skills, threadsDir } = await setup();
    const room = skills.room("alpha");
    const peer = peerOf(room);
    comment(peer, "t-7", "Flag missing tests", "Keep this one");
    const stored = join(threadsDir, "alpha.json");
    await vi.waitFor(() => {
      expect(existsSync(stored)).toBe(true);
    });
    // A host without assistants says so in the thread, as Relay.
    expect(JSON.parse(readFileSync(stored, "utf8"))).toEqual({
      threads: [
        {
          id: "t-7",
          quote: "Flag missing tests",
          resolved: false,
          assignee: "nova",
          messages: [expect.objectContaining({ text: "Keep this one" }), expect.objectContaining({ name: "Relay", text: "Nova cannot answer here: this host runs no assistants." })],
        },
      ],
    });
    const deliver = vi.fn(() => Promise.resolve());
    skills.stop();
    const again = new SkillsService({
      catalog: new SkillCatalog({ home: home.home, evaRoot: home.evaRoot, run: home.run, list: home.list }),
      usage: new SkillUsageIndex({ home: home.home, agentHome: null, assistantsDir: null, cacheFile: null, logFile: null }),
      room: { pacing: { selectMs: 0, typeMs: 0 }, watch: false },
      threadsDir,
      deliver,
    });
    services.push(again);
    await again.refresh();
    const reopened = again.room("alpha");
    const [thread] = snapDocThreads(docThreadsOf(reopened.sync.doc));
    expect(thread?.anchor?.quote).toBe("Flag missing tests");
    // Loaded messages were already handled: nothing is delivered again.
    peerOf(reopened);
    await Promise.resolve();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("drops pending suggestions on reload and re-anchors threads by their quote", async () => {
    const { skills } = await setup();
    const room = skills.room("alpha");
    const peer = peerOf(room);
    comment(peer, "t-8", "Keep every review comment", "Shorter");
    await room.edit({ as: "Nova", thread: "t-8", find: "Keep every review comment under three sentences.", replace: "Short." });
    room.reload();
    expect(snapSuggestions(peer)).toEqual([]);
    expect(room.text()).toBe(SKILL);
    expect(snapDocThreads(docThreadsOf(peer))[0]?.anchor).not.toBeNull();
  });

  it("shows an assistant's caret with its face", async () => {
    const { skills } = await setup();
    const room = skills.room("alpha");
    await room.edit({ as: "Nova", find: "style nits", replace: "nits" });
    expect(room.agentState("Nova")).toMatchObject({ user: { name: "Nova", kind: "agent", avatar: "/canvas/avatar/nova" } });
  });
});
