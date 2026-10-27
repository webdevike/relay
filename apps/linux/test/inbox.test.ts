import { describe, expect, it } from "vitest";
import { INBOX_CATEGORY, type InboxItem, type ServerMessage } from "@relay/protocol";
import { InboxService } from "../src/inbox/service";
import type { PushMessage, PushOutcome } from "../src/push/notifier";

const approval = (id: string, requiresBiometric: boolean): InboxItem => ({
  id: `approval:${id}`,
  kind: "approval",
  sessionId: "s1",
  title: "ENG-6243 style regen needs approval",
  body: requiresBiometric ? "git push --force-with-lease origin style/x" : "npm test",
  at: 1,
  approval: { id, toolName: "bash", command: requiresBiometric ? "git push --force-with-lease origin style/x" : "npm test", requiresBiometric, ...(requiresBiometric ? { destructive: "force push" } : {}) },
});

const ask: InboxItem = {
  id: "ask:a1",
  kind: "ask",
  sessionId: "s2",
  title: "ENG-6227 asked you",
  body: "Apply both nits before merge?",
  at: 2,
  ask: { id: "a1", questionId: "q1", question: "Apply both nits before merge?", options: ["Yes", "No"] },
};

function harness(outcome: (message: PushMessage) => PushOutcome = () => ({ ok: true })) {
  const tokens = new Map([["phone-1", "ExponentPushToken[one]"]]);
  const pushes: PushMessage[] = [];
  const frames: { message: ServerMessage; except: string | null }[] = [];
  const viewing = new Set<string>();
  const logs: string[] = [];
  const service = new InboxService({
    tokens: {
      tokens: () => tokens,
      unregister: (deviceId) => {
        tokens.delete(deviceId);
      },
    },
    sender: {
      send: (messages) => {
        pushes.push(...messages);
        return Promise.resolve(messages.map(outcome));
      },
    },
    broadcast: (message, except) => {
      frames.push({ message, except });
    },
    isViewing: (deviceId, sessionId) => viewing.has(`${deviceId}/${sessionId}`),
    log: (line) => logs.push(line),
  });
  return { service, tokens, pushes, frames, viewing, logs };
}

describe("InboxService items", () => {
  it("relays an item to every device but the escalator and pushes one Time Sensitive notification with its actions", () => {
    const h = harness();
    h.service.item("evaos", approval("t1", true));
    h.service.item("evaos", approval("t2", false));
    h.service.item("evaos", ask);
    expect(h.frames.map((frame) => frame.except)).toEqual(["evaos", "evaos", "evaos"]);
    expect(h.pushes.map((push) => [push.categoryId, push.interruptionLevel])).toEqual([
      [INBOX_CATEGORY.approvalBiometric, "time-sensitive"],
      [INBOX_CATEGORY.approval, "time-sensitive"],
      [INBOX_CATEGORY.ask, "time-sensitive"],
    ]);
    expect(h.pushes[0]).toMatchObject({
      to: "ExponentPushToken[one]",
      title: "ENG-6243 style regen needs approval",
      body: "git push --force-with-lease origin style/x",
      data: { id: "approval:t1", kind: "approval", sessionId: "s1", approvalId: "t1", requiresBiometric: true },
    });
    expect(h.pushes[2]?.data).toMatchObject({ askId: "a1", questionId: "q1", options: ["Yes", "No"] });
  });

  it("does not buzz again for a known id, a silent item, or a session the phone is viewing; a fold shows in the title", () => {
    const h = harness();
    h.service.item("evaos", approval("t1", false));
    h.service.item("evaos", { ...approval("t1", false), more: 1 });
    expect(h.pushes).toHaveLength(1);
    expect(h.frames).toHaveLength(2);
    h.service.item("evaos", { ...ask, silent: true });
    h.viewing.add("phone-1/s1");
    h.service.item("evaos", approval("t3", false));
    expect(h.pushes).toHaveLength(1);
    expect(h.service.pending().map((item) => item.id)).toEqual(["approval:t1", "ask:a1", "approval:t3"]);
  });

  it("ignores items and resolves from anyone but the escalator", () => {
    const h = harness();
    h.service.item("phone-1", approval("t1", false));
    h.service.resolve("phone-1", { id: "approval:t1" });
    expect(h.pushes).toEqual([]);
    expect(h.frames).toEqual([]);
    expect(h.service.pending()).toEqual([]);
    expect(h.logs).toHaveLength(2);
  });

  it("forgets a phone that Expo says is gone", async () => {
    const h = harness(() => ({ ok: false, error: "DeviceNotRegistered", unregistered: true }));
    h.service.item("evaos", approval("t1", false));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.tokens.size).toBe(0);
  });

  it("pushes an item quoting Isaac's prompt without its surface tag", () => {
    const h = harness();
    h.service.item("evaos", { id: "alert:1", kind: "alert", title: "Relay is waiting", body: "<surface>Mac Mini - Relay Desktop</surface>\nfix the dock", at: 1 });
    h.service.item("evaos", { id: "alert:2", kind: "alert", title: "Nova is waiting", body: "<surface>iPhone - Relay</surface>\nbook the table", at: 2 });
    expect(h.pushes.map((push) => push.body)).toEqual(["fix the dock", "book the table"]);
  });
});

describe("InboxService digests", () => {
  it("pushes a digest passively, with no sound, and keeps nothing to replay or withdraw", () => {
    const h = harness();
    const digest: InboxItem = { id: "digest:1", kind: "alert", title: "Morning digest", body: "2 need you, 5 updates", at: 1, passive: true };
    h.service.item("evaos", digest);
    expect(h.frames).toEqual([{ message: { t: "inbox.item", item: digest }, except: "evaos" }]);
    expect(h.pushes).toEqual([{ to: "ExponentPushToken[one]", title: "Morning digest", body: "2 need you, 5 updates", data: { id: "digest:1", kind: "alert" }, interruptionLevel: "passive", sound: null }]);
    expect(h.service.pending()).toEqual([]);
    h.pushes.length = 0;
    h.service.resolve("evaos", { id: "digest:1" });
    expect(h.pushes).toEqual([]);
  });
});

describe("InboxService resolution", () => {
  it("answered on the Mac: tells the phones and withdraws the notification with a silent push", () => {
    const h = harness();
    h.service.item("evaos", approval("t1", false));
    h.pushes.length = 0;
    h.service.resolve("evaos", { id: "approval:t1", answer: "Approved" });
    expect(h.frames.at(-1)).toEqual({ message: { t: "inbox.resolve", id: "approval:t1", by: "mac", answer: "Approved" }, except: "evaos" });
    expect(h.pushes).toEqual([{ to: "ExponentPushToken[one]", data: { withdraw: "approval:t1" }, contentAvailable: true, sound: null }]);
    expect(h.service.pending()).toEqual([]);
  });

  it("does not withdraw what was never pushed", () => {
    const h = harness();
    h.service.item("evaos", { ...approval("t1", false), silent: true });
    h.service.resolve("evaos", { id: "approval:t1" });
    expect(h.pushes).toEqual([]);
  });

  it("answered on a phone: omp's resolved event tells everyone, EvaOS included, who answered", () => {
    const h = harness();
    h.service.item("evaos", approval("t1", true));
    h.pushes.length = 0;
    h.service.claim("approval:t1", "phone-1", "Approved");
    h.service.settled("approval", "t1");
    expect(h.frames.at(-1)).toEqual({ message: { t: "inbox.resolve", id: "approval:t1", by: "phone", answer: "Approved" }, except: null });
    expect(h.pushes).toHaveLength(1);
    expect(h.service.pending()).toEqual([]);
    // A phone answer needs no stored item: the id is derived from the command.
    h.frames.length = 0;
    h.service.claim("ask:zz", "phone-1", "No");
    h.service.settled("ask", "zz");
    expect(h.frames).toEqual([{ message: { t: "inbox.resolve", id: "ask:zz", by: "phone", answer: "No" }, except: null }]);
  });

  it("a claim given back, or the Mac answering, resolves as the Mac", () => {
    const h = harness();
    h.service.item("evaos", ask);
    h.service.claim("ask:a1", "phone-1", "Yes");
    h.service.release("ask:a1");
    h.service.settled("ask", "a1");
    expect(h.frames.at(-1)).toEqual({ message: { t: "inbox.resolve", id: "ask:a1", by: "mac" }, except: "evaos" });
    h.frames.length = 0;
    h.service.settled("ask", "never-escalated");
    expect(h.frames).toEqual([]);
  });
});
