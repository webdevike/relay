import { describe, expect, it } from "vitest";
import type { AssistantMessage, AssistantSnapshot } from "@relay/protocol";
import { sharedSnapshot } from "./assistant";

const message = (id: string, text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({ id, role: "assistant", text, at: 1, ...extra });
const snapshot = (rev: number, messages: AssistantMessage[]): AssistantSnapshot => ({ rev, messages, busy: false, sessionId: "s" });

describe("sharedSnapshot", () => {
  it("keeps the previous objects (and array) when a new frame repeats the thread", () => {
    const before = snapshot(1, [message("a", "hi", { images: [{ id: "x", mimeType: "image/png" }] }), message("b", "there")]);
    const after = sharedSnapshot(before, snapshot(2, structuredClone(before.messages)));
    expect(after.rev).toBe(2);
    expect(after.messages).toBe(before.messages);
  });

  it("takes the new object only for a row that changed, and a new array for an appended row", () => {
    const before = snapshot(1, [message("a", "hi"), message("b", "streaming")]);
    const next = snapshot(2, [message("a", "hi"), message("b", "streaming more"), message("c", "new")]);
    const after = sharedSnapshot(before, next);
    expect(after.messages).not.toBe(before.messages);
    expect(after.messages[0]).toBe(before.messages[0]);
    expect(after.messages[1]).toBe(next.messages[1]);
    expect(after.messages[2]).toBe(next.messages[2]);
  });

  it("treats a nested change (a sign-in submitted) as a change", () => {
    const before = snapshot(1, [message("a", "sign in", { signin: { url: "https://x.test", host: "x.test" } })]);
    const next = snapshot(2, [message("a", "sign in", { signin: { url: "https://x.test", host: "x.test", submitted: true } })]);
    expect(sharedSnapshot(before, next).messages[0]).toBe(next.messages[0]);
  });
});
