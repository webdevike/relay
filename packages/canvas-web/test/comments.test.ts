import { describe, expect, it } from "vitest";
import type { Presence } from "../../canvas-live/src/shared";
import type { ThreadSnap } from "../../canvas-live/src/threads";
import { ago, avatarFor, threadDraft } from "../src/comments";

const NOVA = { name: "Nova", avatar: "/canvas/avatar/nova" };

describe("avatarFor", () => {
  it("draws the room agent with its assistant's own avatar, even where a presence or message came without one", () => {
    expect(avatarFor({ name: "Nova", kind: "agent", avatar: "/canvas/avatar/nova" }, NOVA)).toBe("/canvas/avatar/nova");
    expect(avatarFor({ name: "Nova", kind: "agent" }, NOVA)).toBe("/canvas/avatar/nova");
    expect(avatarFor({ name: "nova" }, NOVA)).toBe("/canvas/avatar/nova");
  });
  it("keeps a worker's portrait, and gives people and unknown agents their initial", () => {
    expect(avatarFor({ name: "Mara", kind: "agent", avatar: "/canvas/portrait/mara" }, NOVA)).toBe("/canvas/portrait/mara");
    expect(avatarFor({ name: "Mara", kind: "agent" }, NOVA)).toBeUndefined();
    expect(avatarFor({ name: "Nova", kind: "human" }, NOVA)).toBeUndefined();
    expect(avatarFor({ name: "Isaac", kind: "human" }, null)).toBeUndefined();
  });
});

describe("ago", () => {
  it("reads short", () => {
    const now = Date.UTC(2026, 10, 5, 12);
    expect(ago(now - 10_000, now)).toBe("now");
    expect(ago(now - 4 * 60_000, now)).toBe("4m");
    expect(ago(now - 2 * 3_600_000, now)).toBe("2h");
    expect(ago(now - 3 * 86_400_000, now)).toBe("3d");
  });
});

describe("threadDraft", () => {
  const thread: ThreadSnap = {
    id: "t-1",
    anchor: { node: "root", x: 10, y: 10 },
    resolved: false,
    messages: [{ id: "c1", kind: "human", name: "Isaac", color: "#0ea5e9", text: "rename it", ts: 1 }],
  };
  const nova = (p: Partial<Presence>): Presence => ({ user: { name: "Nova", color: "#f76707", kind: "agent", avatar: "/canvas/avatar/nova" }, ...p });

  it("shows the agent working on a comment, then its reply streaming into the thread", () => {
    expect(threadDraft([nova({ status: "idle" })], thread)).toBeNull();
    expect(threadDraft([nova({ status: "thinking", replyTo: "c1", doing: "reading files…" })], thread)).toMatchObject({ text: "", label: "reading files…" });
    expect(threadDraft([nova({ status: "thinking", replyTo: "c1", bubble: { text: "Done, renamed", streaming: true, thread: "t-1" } })], thread)).toMatchObject({ text: "Done, renamed", user: { name: "Nova" } });
    // Another thread's reply, or a room line, is not this thread's.
    expect(threadDraft([nova({ status: "thinking", replyTo: "zz", bubble: { text: "x", streaming: true, thread: "t-2" } })], thread)).toBeNull();
  });
});
