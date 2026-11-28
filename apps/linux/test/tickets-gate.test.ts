import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TicketMutation } from "@relay/protocol";
import { ProviderRejected } from "../src/tickets/errors";
import { canonicalJson, MutationGate, mutationHash, type CheckResult, type GatePin, type MutationExecutor } from "../src/tickets/gate";
import { MAX_OPS, OPS_TTL_MS, OpsStore } from "../src/tickets/ops-store";

const T0 = Date.parse("2026-11-27T12:00:00Z");
const ME = "viewer-isaac";
const DEVICE = { deviceId: "device-1" };
const OP1 = "6d796135-613d-4bd8-ae3f-d928a50f7531";
const OP2 = "6d796135-613d-4bd8-ae3f-d928a50f7532";
const OP3 = "6d796135-613d-4bd8-ae3f-d928a50f7533";

const COMMENT: TicketMutation = { kind: "comment", issueId: "issue-1", body: "Looks good" };
const MOVE: TicketMutation = { kind: "setState", issueId: "issue-1", fromStateId: "s-todo", toStateId: "s-doing" };
const DONE_MOVE: TicketMutation = { kind: "setState", issueId: "issue-1", fromStateId: "s-todo", toStateId: "s-done" };
const ROW = { key: "ENG-1", issueId: "issue-1", opId: OP3, baseUpdatedAt: T0, priority: 2 };
const EVERY_KIND: readonly TicketMutation[] = [
  MOVE,
  COMMENT,
  { kind: "editComment", commentId: "c-1", body: "Edited" },
  { kind: "deleteComment", commentId: "c-1", replyCount: 0 },
  { kind: "resolve", rootId: "c-1", on: true },
  { kind: "react", commentId: "c-1", emoji: "+1", on: true },
  { kind: "subscribe", issueId: "issue-1", on: false },
  { kind: "createIssue", teamId: "t-1", stateId: "s-todo", templateId: null, projectId: null, title: "New", description: "", sourceCommentId: "c-1", referenceCommentId: "c-1" },
  { kind: "applyPlan", rows: [ROW] },
];

interface Fake {
  readonly exec: MutationExecutor<TicketMutation>;
  readonly calls: { check: number; run: string[]; reconcile: number };
  checkAnswer: CheckResult;
  runBehavior: "ok" | "lost" | "reject" | "hang";
  reconcileAnswer: "done" | "notDone" | "unknown";
  /** Runs inside check() (a key rotation while validating). */
  onCheck: (() => void) | null;
  /** Resolved when a `hang` write reached the provider (the host "dies" there). */
  readonly hung: { readonly promise: Promise<void>; readonly resolve: () => void };
}

function fakeExecutor(): Fake {
  const fake: Fake = {
    calls: { check: 0, run: [], reconcile: 0 },
    checkAnswer: { ok: true, revision: "rev-1", summary: "Do it" },
    runBehavior: "ok",
    reconcileAnswer: "done",
    onCheck: null,
    hung: Promise.withResolvers<void>(),
    exec: {
      check: (m) => {
        fake.calls.check++;
        fake.onCheck?.();
        const a = fake.checkAnswer;
        return Promise.resolve(m.kind === "setState" && a.ok && a.toStateType === undefined ? { ...a, toStateType: m.toStateId === "s-done" ? "completed" : "started" } : a);
      },
      run: (_m, opId) => {
        fake.calls.run.push(opId);
        if (fake.runBehavior === "lost") return Promise.reject(new Error("socket hang up"));
        if (fake.runBehavior === "reject") return Promise.reject(new ProviderRejected("Linear refused commentCreate"));
        if (fake.runBehavior === "hang") {
          fake.hung.resolve();
          return Promise.withResolvers<never>().promise;
        }
        return Promise.resolve({ id: opId, url: "https://linear.app/x/issue/ENG-1#comment" });
      },
      reconcile: () => {
        fake.calls.reconcile++;
        return Promise.resolve(fake.reconcileAnswer);
      },
    },
  };
  return fake;
}

function setup(over: { dir?: string; fake?: Fake; writes?: boolean; viewerId?: string | null; credential?: string } = {}) {
  const clock = { t: T0 };
  const fake = over.fake ?? fakeExecutor();
  /** The host's verified account and key generation (a rotation moves `generation`). */
  const state = { writes: over.writes ?? true, viewerId: over.viewerId === undefined ? ME : over.viewerId, generation: 1 };
  const dir = over.dir ?? mkdtempSync(join(tmpdir(), "tickets-gate-"));
  const lines: string[] = [];
  const gate = new MutationGate({
    dir,
    writesEnabled: () => state.writes,
    pin: (): GatePin | null => (state.viewerId === null ? null : { viewerId: state.viewerId, generation: state.generation, credential: over.credential ?? "key-1", linear: fake.exec }),
    current: (pin) => pin.viewerId === state.viewerId && pin.generation === state.generation,
    now: () => clock.t,
    log: (l) => lines.push(l),
  });
  return { gate, fake, clock, state, dir, lines };
}

async function approve(gate: MutationGate, m: TicketMutation): Promise<string> {
  const prepared = await gate.prepare(DEVICE, m, ME);
  expect(prepared.ok).toBe(true);
  return prepared.approval?.id ?? "";
}

describe("MutationGate refusals", () => {
  it("refuses every kind when writes are off, before any provider call", async () => {
    const { gate, fake } = setup({ writes: false });
    for (const m of EVERY_KIND) {
      expect((await gate.prepare(DEVICE, m, ME)).refused?.code).toBe("writesOff");
      expect((await gate.commit(DEVICE, { opId: OP1, mutation: m }, ME)).refused?.code).toBe("writesOff");
    }
    expect(fake.calls).toEqual({ check: 0, run: [], reconcile: 0 });
  });

  it("refuses an actor that isn't the identity the host acts as, or an unresolved one", async () => {
    const { gate, fake, state } = setup();
    const other = "viewer-other";
    expect((await gate.prepare(DEVICE, COMMENT, other)).refused?.code).toBe("identity");
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, other)).refused?.code).toBe("identity");
    state.viewerId = null;
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME)).refused?.code).toBe("identity");
    expect(fake.calls).toEqual({ check: 0, run: [], reconcile: 0 });
  });

  it("refuses a confirmed kind committed without an approval", async () => {
    const { gate, fake } = setup();
    for (const m of [COMMENT, DONE_MOVE, EVERY_KIND[3], EVERY_KIND[7], EVERY_KIND[8]] as TicketMutation[]) {
      expect((await gate.commit(DEVICE, { opId: OP1, mutation: m }, ME)).refused?.code).toBe("approval");
    }
    expect(fake.calls.run).toEqual([]);
  });

  it("refuses what check() refuses, writing nothing", async () => {
    const { gate, fake } = setup();
    fake.checkAnswer = { ok: false, code: "conflict", message: "Changed in Linear since you looked" };
    expect((await gate.prepare(DEVICE, COMMENT, ME)).refused).toEqual({ code: "conflict", message: "Changed in Linear since you looked" });
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME)).refused?.code).toBe("conflict");
    expect(fake.calls.run).toEqual([]);
  });
});

describe("MutationGate approvals", () => {
  it("commits a confirmed kind once with its approval, then refuses reusing it", async () => {
    const { gate, fake } = setup();
    const approvalId = await approve(gate, COMMENT);
    const done = await gate.commit(DEVICE, { approvalId, opId: OP1, mutation: COMMENT }, ME);
    expect(done).toEqual({ ok: true, outcome: { opId: OP1, state: "done", result: { id: OP1, url: "https://linear.app/x/issue/ENG-1#comment" } } });
    expect((await gate.commit(DEVICE, { approvalId, opId: OP2, mutation: COMMENT }, ME)).refused?.code).toBe("approval");
    expect(fake.calls.run).toEqual([OP1]);
  });

  it("answers the approval with expiry and check()'s summary", async () => {
    const { gate } = setup();
    const prepared = await gate.prepare(DEVICE, COMMENT, ME);
    expect(prepared.approval).toMatchObject({ expiresAt: T0 + 120_000, summary: "Do it" });
  });

  it("refuses an expired approval", async () => {
    const { gate, fake, clock } = setup();
    const approvalId = await approve(gate, COMMENT);
    clock.t += 120_001;
    const res = await gate.commit(DEVICE, { approvalId, opId: OP1, mutation: COMMENT }, ME);
    expect(res.refused).toEqual({ code: "approval", message: "This confirm expired. Confirm again." });
    expect(fake.calls.run).toEqual([]);
  });

  it("refuses a payload, kind, device or identity other than the approved one", async () => {
    const { gate, fake, state } = setup();
    const a1 = await approve(gate, COMMENT);
    expect((await gate.commit(DEVICE, { approvalId: a1, opId: OP1, mutation: { ...COMMENT, body: "Ship it" } }, ME)).refused?.code).toBe("approval");
    const a2 = await approve(gate, COMMENT);
    expect((await gate.commit({ deviceId: "device-2" }, { approvalId: a2, opId: OP1, mutation: COMMENT }, ME)).refused?.code).toBe("approval");
    const a3 = await approve(gate, COMMENT);
    expect((await gate.commit(DEVICE, { approvalId: a3, opId: OP1, mutation: EVERY_KIND[3] as TicketMutation }, ME)).refused?.code).toBe("approval");
    const a4 = await approve(gate, COMMENT);
    const next = "viewer-new";
    state.viewerId = next;
    expect((await gate.commit(DEVICE, { approvalId: a4, opId: OP1, mutation: COMMENT }, next)).refused?.code).toBe("approval");
    expect(fake.calls.run).toEqual([]);
  });

  it("drops pending approvals on invalidate (cancel)", async () => {
    const { gate, fake } = setup();
    const approvalId = await approve(gate, COMMENT);
    gate.invalidate("identity changed");
    expect((await gate.commit(DEVICE, { approvalId, opId: OP1, mutation: COMMENT }, ME)).refused?.code).toBe("approval");
    expect(fake.calls.run).toEqual([]);
  });

  it("refuses conflict when the live revision changed since prepare", async () => {
    const { gate, fake } = setup();
    const approvalId = await approve(gate, COMMENT);
    fake.checkAnswer = { ok: true, revision: "rev-2", summary: "Do it" };
    expect((await gate.commit(DEVICE, { approvalId, opId: OP1, mutation: COMMENT }, ME)).refused?.code).toBe("conflict");
    expect(fake.calls.run).toEqual([]);
  });

  it("commits unconfirmed kinds and non-terminal moves directly; a terminal move needs an approval", async () => {
    const { gate, fake } = setup();
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME)).outcome?.state).toBe("done");
    expect((await gate.commit(DEVICE, { opId: OP2, mutation: DONE_MOVE }, ME)).refused?.code).toBe("approval");
    const approvalId = await approve(gate, DONE_MOVE);
    expect((await gate.commit(DEVICE, { approvalId, opId: OP3, mutation: DONE_MOVE }, ME)).outcome?.state).toBe("done");
    expect(fake.calls.run).toEqual([OP1, OP3]);
  });
});

describe("MutationGate idempotency", () => {
  it("answers a repeated opId after a disconnect from the store, with one provider call", async () => {
    const { gate, fake } = setup();
    const first = await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME);
    const again = await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME);
    expect(again).toEqual(first);
    expect(fake.calls.run).toEqual([OP1]);
    expect(fake.calls.check).toBe(1);
  });

  it("joins a retry that arrives while the first write is still running", async () => {
    const { gate, fake } = setup();
    const [a, b] = await Promise.all([gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME), gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME)]);
    expect(b).toEqual(a);
    expect(fake.calls.run).toEqual([OP1]);
  });

  it("refuses an opId reused for a different payload", async () => {
    const { gate, fake } = setup();
    await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME);
    const res = await gate.commit(DEVICE, { opId: OP1, mutation: { ...MOVE, toStateId: "s-review" } }, ME);
    expect(res.refused?.code).toBe("invalid");
    expect(fake.calls.run).toEqual([OP1]);
  });

  it("keeps a provider refusal as failed and never rewrites it on retry", async () => {
    const { gate, fake } = setup();
    fake.runBehavior = "reject";
    const first = await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME);
    expect(first).toMatchObject({ ok: false, error: "Linear refused commentCreate", outcome: { opId: OP1, state: "failed" } });
    fake.runBehavior = "ok";
    expect(await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME)).toEqual(first);
    expect(fake.calls.run).toEqual([OP1]);
  });

  it("turns a lost response into unknown and reconciles a retry instead of writing again", async () => {
    const { gate, fake } = setup();
    fake.runBehavior = "lost";
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME)).outcome?.state).toBe("unknown");
    fake.runBehavior = "ok";
    fake.reconcileAnswer = "unknown";
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME)).outcome?.state).toBe("unknown");
    fake.reconcileAnswer = "done";
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME)).outcome?.state).toBe("done");
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME)).outcome?.state).toBe("done");
    expect(fake.calls.run).toEqual([OP1]);
    expect(fake.calls.reconcile).toBe(2);
  });

  it("answers a failure in the host's words, never the provider's error text", async () => {
    const { gate, fake } = setup();
    fake.exec.run = () => Promise.reject(new Error("upstream db7 timeout for lin_api_secret"));
    const res = await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME);
    expect(res.outcome).toEqual({ opId: OP1, state: "unknown", result: { error: "Couldn't reach Linear. Try again in a moment." } });
    fake.exec.check = () => Promise.reject(new ProviderRejected("Forbidden: issue 1234 in workspace acme-secret", "Linear refused the request"));
    expect(await gate.prepare(DEVICE, COMMENT, ME)).toEqual({ ok: false, error: "Linear refused the request" });
  });
});

describe("MutationGate pins the account and key for the whole op", () => {
  it("refuses with no write when the key rotates or the account changes while checking", async () => {
    const { gate, fake, state } = setup();
    fake.onCheck = () => {
      state.generation += 1;
    };
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME)).refused?.code).toBe("identity");
    expect((await gate.prepare(DEVICE, COMMENT, ME)).refused?.code).toBe("identity");
    fake.onCheck = () => {
      state.viewerId = "viewer-new";
    };
    state.viewerId = ME;
    expect((await gate.commit(DEVICE, { opId: OP2, mutation: MOVE }, ME)).refused?.code).toBe("identity");
    expect(fake.calls.run).toEqual([]);
  });

  it("voids an approval made before a key rotation", async () => {
    const { gate, fake, state } = setup();
    const approvalId = await approve(gate, COMMENT);
    state.generation += 1;
    expect((await gate.commit(DEVICE, { approvalId, opId: OP1, mutation: COMMENT }, ME)).refused?.code).toBe("approval");
    expect(fake.calls.run).toEqual([]);
  });

  it("answers a stored outcome only to the account and device that started it", async () => {
    const { gate, fake } = setup();
    await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME);
    expect((await gate.commit({ deviceId: "device-2" }, { opId: OP1, mutation: MOVE }, ME)).refused?.code).toBe("identity");
    expect(fake.calls.run).toEqual([OP1]);
  });
});

describe("MutationGate after a restart", () => {
  /** Starts `m` (approved when confirmed) and leaves its write hanging, as a host that died there. */
  async function crashMidWrite(m: TicketMutation = MOVE): Promise<{ dir: string; fake: Fake }> {
    const first = setup();
    first.fake.runBehavior = "hang";
    const approvalId = m.kind === "setState" ? undefined : await approve(first.gate, m);
    void first.gate.commit(DEVICE, { opId: OP1, mutation: m, ...(approvalId === undefined ? {} : { approvalId }) }, ME);
    await first.fake.hung.promise;
    const file = JSON.parse(readFileSync(join(first.dir, "ops.json"), "utf8")) as { ops: Record<string, { state: string; viewerId: string; deviceId: string; revision: string }> };
    expect(file.ops[OP1]).toMatchObject({ state: "running", viewerId: ME, deviceId: DEVICE.deviceId, revision: "rev-1" });
    first.fake.runBehavior = "ok";
    return { dir: first.dir, fake: first.fake };
  }

  it("loads running as unknown, reconciles it as done and does not write again", async () => {
    const { dir, fake } = await crashMidWrite();
    const { gate } = setup({ dir, fake });
    expect(await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME)).toEqual({ ok: true, outcome: { opId: OP1, state: "done" } });
    expect(fake.calls.run).toEqual([OP1]);
    expect(fake.calls.reconcile).toBe(1);
  });

  it("never reapplies a move Linear doesn't show now (someone may have moved it back since it landed)", async () => {
    const { dir, fake } = await crashMidWrite();
    fake.reconcileAnswer = "notDone";
    const checks = fake.calls.check;
    const { gate } = setup({ dir, fake });
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME)).outcome?.state).toBe("unknown");
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME)).outcome?.state).toBe("unknown");
    expect(fake.calls.run).toEqual([OP1]);
    expect(fake.calls.check).toBe(checks);
  });

  it("resends a stable-id create Linear doesn't have once, with the same id, at the approved revision", async () => {
    const { dir, fake } = await crashMidWrite(COMMENT);
    fake.reconcileAnswer = "notDone";
    const { gate } = setup({ dir, fake });
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: COMMENT }, ME)).outcome?.state).toBe("done");
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: COMMENT }, ME)).outcome?.state).toBe("done");
    expect(fake.calls.run).toEqual([OP1, OP1]);
  });

  it("doesn't resend a create whose approved revision changed", async () => {
    const { dir, fake } = await crashMidWrite(COMMENT);
    fake.reconcileAnswer = "notDone";
    fake.checkAnswer = { ok: true, revision: "rev-2", summary: "Do it" };
    const { gate } = setup({ dir, fake });
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: COMMENT }, ME)).refused?.code).toBe("conflict");
    expect(fake.calls.run).toEqual([OP1]);
  });

  it("keeps a resent create Linear refuses as unknown (the first may have landed late)", async () => {
    const { dir, fake } = await crashMidWrite(COMMENT);
    fake.reconcileAnswer = "notDone";
    fake.runBehavior = "reject";
    const { gate } = setup({ dir, fake });
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: COMMENT }, ME)).outcome?.state).toBe("unknown");
    expect(fake.calls.run).toEqual([OP1, OP1]);
  });

  it("refuses a stable-create resend after a restart under a rotated key, sending nothing", async () => {
    const { dir, fake } = await crashMidWrite(COMMENT);
    fake.reconcileAnswer = "notDone";
    const { gate } = setup({ dir, fake, credential: "key-2" });
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: COMMENT }, ME)).refused?.code).toBe("identity");
    expect(fake.calls.run).toEqual([OP1]);
  });

  it("refuses a retry as another account or from another device, with no provider call", async () => {
    const { dir, fake } = await crashMidWrite(COMMENT);
    const reconciles = fake.calls.reconcile;
    const other = setup({ dir, fake, viewerId: "viewer-new" });
    expect((await other.gate.commit(DEVICE, { opId: OP1, mutation: COMMENT }, "viewer-new")).refused?.code).toBe("identity");
    const { gate } = setup({ dir, fake });
    expect((await gate.commit({ deviceId: "device-2" }, { opId: OP1, mutation: COMMENT }, ME)).refused?.code).toBe("identity");
    expect(fake.calls.reconcile).toBe(reconciles);
    expect(fake.calls.run).toEqual([OP1]);
  });

  it("stays unknown (never writes blindly) while reconcile can't tell", async () => {
    const { dir, fake } = await crashMidWrite();
    fake.reconcileAnswer = "unknown";
    const { gate } = setup({ dir, fake });
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: MOVE }, ME)).outcome).toEqual({ opId: OP1, state: "unknown" });
    expect(fake.calls.run).toEqual([OP1]);
  });
});

describe("OpsStore", () => {
  it("drops records older than 14 days and keeps the newest 2000", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickets-ops-"));
    const rec = { state: "done", kind: "react", hash: "h", viewerId: ME, deviceId: DEVICE.deviceId, revision: "r", credential: "key-1" } as const;
    const ops = Object.fromEntries(Array.from({ length: MAX_OPS + 1 }, (_, i) => [`op-${String(i)}`, { ...rec, at: T0 + i }]));
    writeFileSync(join(dir, "ops.json"), JSON.stringify({ v: 1, ops: { ...ops, stale: { ...rec, at: T0 - OPS_TTL_MS - 1 } } }));
    const store = new OpsStore(dir, () => T0);
    store.put("op-new", { ...rec, at: T0 + MAX_OPS + 5 });
    const saved = JSON.parse(readFileSync(join(dir, "ops.json"), "utf8")) as { v: number; ops: Record<string, unknown> };
    expect(saved.v).toBe(1);
    expect(Object.keys(saved.ops)).toHaveLength(MAX_OPS);
    expect(saved.ops["stale"]).toBeUndefined();
    expect(saved.ops["op-0"]).toBeUndefined();
    expect(saved.ops["op-1"]).toBeUndefined();
    expect(saved.ops["op-2"]).toBeDefined();
    expect(saved.ops["op-new"]).toBeDefined();
  });

  it("starts empty from a newer schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickets-ops-"));
    writeFileSync(join(dir, "ops.json"), JSON.stringify({ v: 2, ops: { a: { state: "done", kind: "react", hash: "h", at: T0 } } }));
    expect(new OpsStore(dir, () => T0).get("a")).toBeUndefined();
  });
});

describe("mutationHash", () => {
  it("ignores key order and undefined fields", () => {
    expect(canonicalJson({ b: 1, a: [{ d: undefined, c: 2 }] })).toBe('{"a":[{"c":2}],"b":1}');
    expect(mutationHash({ body: "x", issueId: "i", kind: "comment", parentId: undefined })).toBe(mutationHash({ kind: "comment", issueId: "i", body: "x" }));
  });
});
