import { describe, expect, it } from "vitest";
import type { Command } from "@relay/protocol";
import { ACTION, answerFromNotification, approve, deny, parseInboxData, pickOption, withdrawIdOf, type AnswerDeps, type InboxNotificationData } from "./answer";

function deps(options: { faceId?: boolean; online?: boolean; fail?: string } = {}) {
  const sent: Command[] = [];
  const prompts: string[] = [];
  const value: AnswerDeps = {
    authenticate: (reason) => {
      prompts.push(reason);
      return Promise.resolve(options.faceId ?? true);
    },
    whenConnected: () => Promise.resolve(options.online ?? true),
    send: (cmd) => {
      if (options.fail !== undefined) return Promise.reject(new Error(options.fail));
      sent.push(cmd);
      return Promise.resolve();
    },
  };
  return { deps: value, sent, prompts };
}

const ordinary: InboxNotificationData = { id: "approval:t1", kind: "approval", sessionId: "s1", approvalId: "t1", requiresBiometric: false };
const destructive: InboxNotificationData = { ...ordinary, id: "approval:t2", approvalId: "t2", requiresBiometric: true, destructive: "force push" };
const ask: InboxNotificationData = { id: "ask:a1", kind: "ask", sessionId: "s2", askId: "a1", questionId: "q1", options: ["Yes", "No", "Later"] };

describe("approvals", () => {
  it("an ordinary approval is one tap: no Face ID, no confirmation", async () => {
    const h = deps();
    expect(await answerFromNotification(ordinary, ACTION.approve, undefined, h.deps)).toEqual({ status: "sent" });
    expect(h.prompts).toEqual([]);
    expect(h.sent).toEqual([{ kind: "agent.approve", sessionId: "s1", approvalId: "t1" }]);
  });

  it("a destructive approval asks for Face ID naming the pattern and sends confirmed: biometric", async () => {
    const h = deps();
    expect(await answerFromNotification(destructive, ACTION.approve, undefined, h.deps)).toEqual({ status: "sent" });
    expect(h.prompts).toEqual(["Approve force push"]);
    expect(h.sent).toEqual([{ kind: "agent.approve", sessionId: "s1", approvalId: "t2", confirmed: "biometric" }]);
  });

  it("sends nothing when Face ID fails or is cancelled, so the agent stays blocked", async () => {
    const h = deps({ faceId: false });
    expect(await answerFromNotification(destructive, ACTION.approve, undefined, h.deps)).toEqual({ status: "cancelled" });
    expect(h.sent).toEqual([]);
  });

  it("treats a payload that does not say whether Face ID is needed as destructive", async () => {
    const h = deps();
    const unknown: InboxNotificationData = { id: ordinary.id, kind: "approval", sessionId: "s1", approvalId: "t1" };
    await answerFromNotification(unknown, ACTION.approve, undefined, h.deps);
    expect(h.prompts).toEqual(["Approve this destructive action"]);
  });

  it("deny never needs Face ID, even for a destructive call", async () => {
    const h = deps({ faceId: false });
    expect(await answerFromNotification(destructive, ACTION.deny, undefined, h.deps)).toEqual({ status: "sent" });
    expect(h.sent).toEqual([{ kind: "agent.deny", sessionId: "s1", approvalId: "t2" }]);
    expect(await deny({ sessionId: "s1", approvalId: "t9" }, h.deps)).toEqual({ status: "sent" });
  });

  it("reports offline and a failed command without throwing", async () => {
    expect(await approve({ sessionId: "s1", approvalId: "t1", requiresBiometric: false }, deps({ online: false }).deps)).toEqual({ status: "offline" });
    expect(await approve({ sessionId: "s1", approvalId: "t1", requiresBiometric: false }, deps({ fail: "biometric_required" }).deps)).toEqual({ status: "failed", message: "biometric_required" });
  });

  it("ignores an Open tap and anything it cannot act on", async () => {
    const h = deps();
    expect(await answerFromNotification(ordinary, ACTION.open, undefined, h.deps)).toEqual({ status: "ignored" });
    expect(await answerFromNotification({ id: "x", kind: "alert" }, ACTION.approve, undefined, h.deps)).toEqual({ status: "ignored" });
    expect(h.sent).toEqual([]);
  });
});

describe("asks", () => {
  it("answers with the option the typed text names, by label or by number, else with the text", async () => {
    expect(pickOption(["Yes", "No"], " yes ")).toEqual({ selectedOptions: ["Yes"] });
    expect(pickOption(["Yes", "No"], "2")).toEqual({ selectedOptions: ["No"] });
    expect(pickOption(["Yes", "No"], "3")).toEqual({ selectedOptions: [], customInput: "3" });
    expect(pickOption(["Yes", "No"], "only the nits")).toEqual({ selectedOptions: [], customInput: "only the nits" });
    const h = deps();
    await answerFromNotification(ask, ACTION.answer, "later", h.deps);
    await answerFromNotification(ask, ACTION.answer, "apply the first nit only", h.deps);
    expect(h.sent).toEqual([
      { kind: "agent.ask.answer", sessionId: "s2", askId: "a1", results: [{ id: "q1", selectedOptions: ["Later"] }] },
      { kind: "agent.ask.answer", sessionId: "s2", askId: "a1", results: [{ id: "q1", selectedOptions: [], customInput: "apply the first nit only" }] },
    ]);
  });

  it("ignores an empty answer", async () => {
    const h = deps();
    expect(await answerFromNotification(ask, ACTION.answer, "  ", h.deps)).toEqual({ status: "ignored" });
    expect(h.sent).toEqual([]);
  });
});

describe("notification payloads", () => {
  it("reads the inbox data of a push and rejects other notifications", () => {
    expect(parseInboxData({ id: "approval:t1", kind: "approval", sessionId: "s1", approvalId: "t1", requiresBiometric: true })).toMatchObject({ approvalId: "t1" });
    expect(parseInboxData({ sessionId: "s1" })).toBeNull();
    expect(parseInboxData({ dropId: "d1" })).toBeNull();
    expect(parseInboxData(undefined)).toBeNull();
  });

  it("finds a withdraw id wherever Expo nests the data", () => {
    expect(withdrawIdOf({ withdraw: "approval:t1" })).toBe("approval:t1");
    expect(withdrawIdOf({ data: { withdraw: "ask:a1" } })).toBe("ask:a1");
    expect(withdrawIdOf({ notification: { request: { content: { data: { withdraw: "x" } } } } })).toBe("x");
    expect(withdrawIdOf({ aps: { "content-available": 1 }, body: JSON.stringify({ withdraw: "approval:t2" }) })).toBe("approval:t2");
    expect(withdrawIdOf({ aps: {}, body: "{not json" })).toBeNull();
    expect(withdrawIdOf({ withdraw: "" })).toBeNull();
    expect(withdrawIdOf(null)).toBeNull();
  });
});
