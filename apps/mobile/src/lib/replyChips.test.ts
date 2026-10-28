import { describe, expect, it } from "vitest";
import type { AssistantMessage, AssistantSnapshot } from "@relay/protocol";
import { liveReplies } from "./replyChips";

const REPLIES = ["Yes, push it", "Not yet"];
const ask: AssistantMessage = { id: "a2", role: "assistant", text: "Push it?", at: 2, replies: REPLIES };
const snapshot = (messages: AssistantMessage[], busy = false): AssistantSnapshot => ({ rev: 1, busy, sessionId: "s", messages });

describe("liveReplies", () => {
  it("shows the newest assistant row's replies once the thread is settled", () => {
    expect(liveReplies(snapshot([{ id: "u1", role: "user", text: "Ready?", at: 1 }, ask]), null)).toEqual(REPLIES);
  });

  it("shows none while the reply streams or the thread works, or while a sent turn waits to land", () => {
    expect(liveReplies(snapshot([ask], true), null)).toBeNull();
    expect(liveReplies(snapshot([ask]), { text: "Not yet" })).toBeNull();
    expect(liveReplies(null, null)).toBeNull();
  });

  it("shows none for an older turn: a later user row or a later reply without replies", () => {
    expect(liveReplies(snapshot([ask, { id: "u3", role: "user", text: "Not yet", at: 3 }]), null)).toBeNull();
    expect(liveReplies(snapshot([ask, { id: "a3", role: "assistant", text: "Ok.", at: 3 }]), null)).toBeNull();
    expect(liveReplies(snapshot([ask, { id: "c3", role: "card", text: "Canvas", at: 3 }]), null)).toBeNull();
  });

  it("looks past status rows, which the thread never shows, and ignores a lone reply", () => {
    expect(liveReplies(snapshot([ask, { id: "s3", role: "status", text: "job done", at: 3 }]), null)).toEqual(REPLIES);
    expect(liveReplies(snapshot([{ ...ask, replies: ["Yes"] }]), null)).toBeNull();
    expect(liveReplies(snapshot([]), null)).toBeNull();
  });
});
