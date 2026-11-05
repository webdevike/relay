import { chmodSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { DOC_KEYS } from "../src/skills/doc";
import { type RoomOptions, SkillRoom } from "../src/skills/room";
import { type SkillsHome, skillsHome, skillText } from "./skills-home";

const homes: SkillsHome[] = [];
const rooms: SkillRoom[] = [];
const FAST: RoomOptions = { pacing: { selectMs: 0, typeMs: 0 }, watch: false, colorFor: (name) => (name === "Nova" ? "#f76707" : "#123456") };

function room(path = "Eva/.omp/skills/alpha/SKILL.md", options: RoomOptions = FAST): { home: SkillsHome; room: SkillRoom; file: string } {
  const home = skillsHome();
  homes.push(home);
  const file = join(home.home, path);
  const opened = new SkillRoom("alpha", file, options);
  rooms.push(opened);
  return { home, room: opened, file };
}

afterEach(() => {
  for (const opened of rooms.splice(0)) opened.dispose();
  for (const home of homes.splice(0)) home.cleanup();
});

/** The doc's text node containing `needle`. */
function textWith(doc: Y.Doc, needle: string): Y.XmlText {
  for (const block of doc.getXmlFragment(DOC_KEYS.body).toArray()) {
    if (block instanceof Y.XmlElement) {
      for (const child of block.toArray()) if (child instanceof Y.XmlText && child.toJSON().includes(needle)) return child;
    }
  }
  throw new Error(`no text with ${needle}`);
}

const state = (opened: SkillRoom): Record<string, unknown> => opened.sync.doc.getMap(DOC_KEYS.state).toJSON();

/** The awareness states other than the room's own, by user name. */
function presence(opened: SkillRoom): Record<string, { user: { name: string; color: string; kind: string }; cursor: { anchor: unknown; head: unknown } | null }> {
  const out: Record<string, { user: { name: string; color: string; kind: string }; cursor: { anchor: unknown; head: unknown } | null }> = {};
  for (const value of opened.sync.awareness.getStates().values()) {
    const entry = value as { user: { name: string; color: string; kind: string }; cursor: { anchor: unknown; head: unknown } | null };
    out[entry.user.name] = entry;
  }
  return out;
}

const absolute = (opened: SkillRoom, json: unknown): { type: Y.AbstractType<unknown>; index: number } | null =>
  Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), opened.sync.doc);

describe("SkillRoom", () => {
  it("tracks dirty against the file as loaded", () => {
    const { room: opened } = room();
    expect(state(opened)).toEqual({ dirty: false, diskChanged: false, savedAt: null, error: null });
    const text = textWith(opened.sync.doc, "Body of alpha");
    text.insert(0, "New ");
    opened.recompute();
    expect(state(opened)["dirty"]).toBe(true);
    text.delete(0, 4);
    opened.recompute();
    expect(state(opened)["dirty"]).toBe(false);
  });

  it("debounces the dirty check after doc updates", async () => {
    const { room: opened } = room();
    opened.sync.doc.getMap(DOC_KEYS.front).set("description", "Changed");
    expect(state(opened)["dirty"]).toBe(false);
    await vi.waitFor(() => {
      expect(state(opened)["dirty"]).toBe(true);
    });
  });

  it("saves atomically through a symlink, keeping the link and the mode", () => {
    const { home, room: opened } = room(".claude/skills/gamma/SKILL.md");
    const real = join(home.home, ".agents/skills/gamma/SKILL.md");
    chmodSync(real, 0o640);
    expect(opened.realFile).toBe(real.replace(/^\/var\//, "/private/var/"));
    textWith(opened.sync.doc, "Body of gamma").insert(0, "Saved ");
    const savedAt = opened.save();
    expect(readFileSync(real, "utf8")).toBe(skillText("gamma", "Gamma skill").replace("Body of gamma", "Saved Body of gamma"));
    expect(lstatSync(join(home.home, ".claude/skills/gamma")).isSymbolicLink()).toBe(true);
    expect(statSync(real).mode & 0o777).toBe(0o640);
    expect(readdirSync(join(home.home, ".agents/skills/gamma"))).toEqual(["SKILL.md"]);
    expect(state(opened)).toEqual({ dirty: false, diskChanged: false, savedAt, error: null });
  });

  it("refuses to save over a file changed on disk unless forced", () => {
    const { room: opened, file } = room();
    textWith(opened.sync.doc, "Body of alpha").insert(0, "Mine: ");
    writeFileSync(file, skillText("alpha", "Edited elsewhere"));
    let refused: unknown = null;
    try {
      opened.save();
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({ status: 409, message: "changed-on-disk" });
    expect(state(opened)["diskChanged"]).toBe(true);
    opened.save(true);
    expect(readFileSync(file, "utf8")).toContain("Mine: Body of alpha");
    expect(readFileSync(file, "utf8")).toContain("description: Alpha skill");
    expect(state(opened)["diskChanged"]).toBe(false);
  });

  it("reloads a clean doc in place when the file changes, and only flags a dirty one", () => {
    const { room: opened, file } = room();
    const heading = textWith(opened.sync.doc, "alpha");
    writeFileSync(file, skillText("alpha", "Alpha skill").replace("Body of alpha.", "Body changed on disk."));
    opened.checkDisk();
    expect(opened.text()).toContain("Body changed on disk.");
    // The unchanged heading is the same Yjs text, so carets in it survive.
    expect(textWith(opened.sync.doc, "alpha")).toBe(heading);
    expect(state(opened)).toMatchObject({ dirty: false, diskChanged: false });
    textWith(opened.sync.doc, "Body changed").insert(0, "Mine ");
    writeFileSync(file, skillText("alpha", "Third version"));
    opened.checkDisk();
    expect(state(opened)).toMatchObject({ dirty: true, diskChanged: true });
    expect(opened.text()).toContain("Mine Body changed on disk.");
    opened.reload();
    expect(opened.text()).toBe(skillText("alpha", "Third version"));
    expect(state(opened)).toMatchObject({ dirty: false, diskChanged: false });
  });

  it("notices outside writes through the file watch", async () => {
    const { room: opened, file } = room(undefined, { ...FAST, watch: true });
    writeFileSync(file, skillText("alpha", "Alpha skill").replace("Body of alpha.", "Watched change."));
    await vi.waitFor(
      () => {
        expect(opened.text()).toContain("Watched change.");
      },
      { timeout: 3000 },
    );
  });

  it("replaces found text as an agent with its own named caret", async () => {
    const { room: opened } = room();
    const result = await opened.edit({ as: "Nova", find: "of alpha", replace: "of the alpha skill" });
    expect(result).toEqual({ ok: true, dirty: true, saved: false });
    expect(opened.text()).toBe(skillText("alpha", "Alpha skill").replace("Body of alpha.", "Body of the alpha skill."));
    const nova = presence(opened)["Nova"];
    expect(nova?.user).toEqual({ name: "Nova", color: "#f76707", kind: "agent" });
    const anchor = absolute(opened, nova?.cursor?.anchor);
    const head = absolute(opened, nova?.cursor?.head);
    expect(anchor?.type).toBe(textWith(opened.sync.doc, "Body of the"));
    expect(anchor?.index).toBe("Body of the alpha skill".length);
    expect(head?.index).toBe(anchor?.index);
  });

  it("refuses text that is missing or not unique", async () => {
    const { home, room: opened } = room();
    await expect(opened.edit({ as: "Nova", find: "nowhere", replace: "x" })).rejects.toMatchObject({ status: 422 });
    await expect(opened.edit({ as: "Nova", find: "alpha", replace: "x" })).rejects.toMatchObject({ status: 422, message: expect.stringContaining("2 times") as unknown });
    await expect(opened.edit({ as: "Nova", find: "x" })).rejects.toMatchObject({ status: 400 });
    expect(home.calls).toEqual([]);
  });

  it("applies a markdown rewrite, puts the caret on the first changed block and saves", async () => {
    const { room: opened, file } = room();
    const next = skillText("alpha", "Alpha skill").replace("Body of alpha.", "Body of alpha.\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    const result = await opened.edit({ as: "Polaris", color: "#00aa00", markdown: next, save: true });
    expect(result).toEqual({ ok: true, dirty: false, saved: true });
    // The agent's own table source is written as is, not re-padded.
    expect(readFileSync(file, "utf8")).toBe(next);
    const polaris = presence(opened)["Polaris"];
    expect(polaris?.user.color).toBe("#00aa00");
    const caret = absolute(opened, polaris?.cursor?.anchor);
    expect(caret?.type).toBeInstanceOf(Y.XmlText);
    expect(caret?.type.toJSON()).toBe("a");
    expect(caret?.index).toBe(0);
  });

  it("takes an agent's caret out on leave and after it idles", async () => {
    const { room: opened } = room(undefined, { ...FAST, agentIdleMs: 30 });
    await opened.edit({ as: "Nova", find: "Body", replace: "Text" });
    expect(opened.agentCount).toBe(1);
    opened.leave("nova");
    expect(presence(opened)["Nova"]).toBeUndefined();
    await opened.edit({ as: "Astra", find: "Text", replace: "Body" });
    expect(presence(opened)["Astra"]).toBeDefined();
    await vi.waitFor(() => {
      expect(opened.agentCount).toBe(0);
    });
    expect(presence(opened)["Astra"]).toBeUndefined();
  });

  it("is idle only without peers, agents or unsaved edits", () => {
    let now = 1_000_000;
    const { room: opened } = room(undefined, { ...FAST, now: () => now });
    expect(opened.idle(now)).toBe(false);
    now += 5 * 60_000;
    expect(opened.idle(now)).toBe(true);
    textWith(opened.sync.doc, "Body").insert(0, "x");
    opened.recompute();
    now += 5 * 60_000;
    expect(opened.idle(now)).toBe(false);
  });
});
