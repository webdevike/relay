import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TicketMutation } from "@relay/protocol";
import { linearGql } from "../src/reviews/linear";
import { MutationGate } from "../src/tickets/gate";
import { linearExecutor } from "../src/tickets/linear-writes";

const T0 = Date.parse("2026-11-27T12:00:00Z");
const ME = "viewer-isaac";
const ACTOR = ME;
const DEVICE = { deviceId: "device-1" };
const OP1 = "6d796135-613d-4bd8-ae3f-d928a50f7531";
const OP2 = "6d796135-613d-4bd8-ae3f-d928a50f7532";
const ROW_A = "6d796135-613d-4bd8-ae3f-d928a50f75a1";
const ROW_B = "6d796135-613d-4bd8-ae3f-d928a50f75b2";
const ROW_C = "6d796135-613d-4bd8-ae3f-d928a50f75c3";

interface FIssue {
  id: string;
  identifier: string;
  stateId: string;
  teamId: string;
  subscribers: string[];
  updatedAt: string;
  dueDate: string | null;
  priority: number;
  prioritySortOrder: number;
}
interface FComment {
  id: string;
  issueId: string;
  parentId: string | null;
  userId: string | null;
  body: string;
  updatedAt: string;
  resolvedAt: string | null;
  reactions: { id: string; emoji: string; userId: string }[];
}
type Vars = Record<string, unknown>;
type Fault = "lost" | "reject";

const STATES = [
  { id: "s-todo", name: "Todo", type: "unstarted" },
  { id: "s-doing", name: "In Progress", type: "started" },
  { id: "s-done", name: "Done", type: "completed" },
];

/** Linear's GraphQL as the executor uses it, keyed by operation name; records every call. */
class FakeLinear {
  readonly calls: { op: string; vars: Vars }[] = [];
  readonly teams = [{ id: "t-1", key: "ENG", states: STATES }];
  readonly issues = new Map<string, FIssue>();
  readonly comments = new Map<string, FComment>();
  /** A write that fails: `lost` applies it and then loses the response; `reject` answers success false. */
  fault: (op: string, vars: Vars) => Fault | undefined = () => undefined;
  private tick = 0;

  constructor() {
    for (const n of [1, 2, 3]) {
      const id = `issue-${String(n)}`;
      this.issues.set(id, { id, identifier: `ENG-${String(n)}`, stateId: "s-todo", teamId: "t-1", subscribers: [ME], updatedAt: new Date(T0).toISOString(), dueDate: null, priority: 0, prioritySortOrder: n });
    }
    this.addComment({ id: "c-root", issueId: "issue-1", parentId: null, userId: "viewer-nova", body: "Can you look?" });
    this.addComment({ id: "c-mine", issueId: "issue-1", parentId: "c-root", userId: ME, body: "On it" });
    this.addComment({ id: "c-own-root", issueId: "issue-1", parentId: null, userId: ME, body: "Note" });
  }

  addComment(c: Omit<FComment, "updatedAt" | "resolvedAt" | "reactions">): void {
    this.comments.set(c.id, { ...c, updatedAt: new Date(T0).toISOString(), resolvedAt: null, reactions: [] });
  }

  mutations(op?: string): { op: string; vars: Vars }[] {
    return this.calls.filter((c) => (op === undefined ? /^Ticket.*(Update|Create|Delete|Resolve|Unresolve|Subscribe|Unsubscribe)$/.test(c.op) : c.op === op));
  }

  readonly gql = (query: string, vars: Vars): Promise<unknown> => {
    const op = /^(?:query|mutation) (\w+)/.exec(query)?.[1] ?? "?";
    this.calls.push({ op, vars });
    const fault = this.fault(op, vars);
    if (fault === "reject") return Promise.resolve({ [this.field(query)]: { success: false } });
    const handler = (this.handlers as Record<string, ((v: Vars) => unknown) | undefined>)[op];
    if (handler === undefined) return Promise.reject(new Error(`unexpected ${op}`));
    const data = handler(vars);
    return fault === "lost" ? Promise.reject(new Error("socket hang up")) : Promise.resolve(data);
  };

  private field(query: string): string {
    return /\{\s*(\w+)\(/.exec(query)?.[1] ?? "";
  }

  private now(): string {
    this.tick++;
    return new Date(T0 + this.tick * 1000).toISOString();
  }

  private issueOut(i: FIssue) {
    const team = this.teams.find((t) => t.id === i.teamId);
    const state = STATES.find((s) => s.id === i.stateId);
    return { ...i, url: `https://linear.app/ecard/issue/${i.identifier}`, state, team: team && { id: team.id, states: { nodes: team.states } }, subscribers: { nodes: i.subscribers.map((id) => ({ id })) } };
  }

  private commentOut(c: FComment) {
    const issue = this.issues.get(c.issueId);
    return {
      ...c,
      url: `https://linear.app/ecard/comment/${c.id}`,
      user: c.userId === null ? null : { id: c.userId },
      parent: c.parentId === null ? null : { id: c.parentId },
      issue: issue && { id: issue.id, identifier: issue.identifier },
      children: { nodes: [...this.comments.values()].filter((x) => x.parentId === c.id).map((x) => ({ id: x.id })) },
      reactions: c.reactions.map((r) => ({ id: r.id, emoji: r.emoji, user: { id: r.userId } })),
    };
  }

  private issue(id: unknown) {
    const i = this.issues.get(String(id));
    return i ? this.issueOut(i) : null;
  }

  private comment(id: unknown) {
    const c = this.comments.get(String(id));
    return c ? this.commentOut(c) : null;
  }

  private readonly handlers = {
    TicketIssueStates: (v: Vars) => ({ issue: this.issue(v["id"]) }),
    TicketIssueState: (v: Vars) => ({ issue: this.issue(v["id"]) }),
    TicketIssueRef: (v: Vars) => ({ issue: this.issue(v["id"]) }),
    TicketIssueSubscribers: (v: Vars) => ({ issue: this.issue(v["id"]) }),
    TicketIssueExists: (v: Vars) => ({ issues: { nodes: [this.issue(v["id"])].filter((x) => x !== null) } }),
    TicketPlanIssues: (v: Vars) => ({ issues: { nodes: (v["ids"] as string[]).map((id) => this.issue(id)).filter((x) => x !== null) } }),
    TicketTeamStates: (v: Vars) => {
      const team = this.teams.find((t) => t.id === v["id"]);
      return { team: team ? { id: team.id, key: team.key, states: { nodes: team.states } } : null };
    },
    TicketCommentRef: (v: Vars) => ({ comment: this.comment(v["id"]) }),
    TicketCommentReplies: (v: Vars) => ({ comment: this.comment(v["id"]) }),
    TicketCommentReactions: (v: Vars) => ({ comment: this.comment(v["id"]) }),
    TicketCommentExists: (v: Vars) => ({ comments: { nodes: [this.comment(v["id"])].filter((x) => x !== null) } }),
    TicketIssueUpdate: (v: Vars) => {
      const i = this.issues.get(String(v["id"]));
      if (i === undefined) throw new Error("Entity not found");
      Object.assign(i, v["input"], { updatedAt: this.now() });
      return { issueUpdate: { success: true, issue: this.issueOut(i) } };
    },
    TicketIssueCreate: (v: Vars) => {
      const input = v["input"] as { id: string; teamId: string; stateId: string };
      const i: FIssue = { id: input.id, identifier: `ENG-${String(this.issues.size + 1)}`, stateId: input.stateId, teamId: input.teamId, subscribers: [ME], updatedAt: this.now(), dueDate: null, priority: 0, prioritySortOrder: 0 };
      this.issues.set(i.id, i);
      return { issueCreate: { success: true, issue: this.issueOut(i) } };
    },
    TicketIssueSubscribe: (v: Vars) => {
      this.issues.get(String(v["id"]))?.subscribers.push(ME);
      return { issueSubscribe: { success: true } };
    },
    TicketIssueUnsubscribe: (v: Vars) => {
      const i = this.issues.get(String(v["id"]));
      if (i) i.subscribers = i.subscribers.filter((s) => s !== ME);
      return { issueUnsubscribe: { success: true } };
    },
    TicketCommentCreate: (v: Vars) => {
      const input = v["input"] as { id: string; issueId?: string; parentId?: string; body: string };
      this.addComment({ id: input.id, issueId: input.issueId ?? "issue-1", parentId: input.parentId ?? null, userId: ME, body: input.body });
      return { commentCreate: { success: true, comment: { id: input.id, url: `https://linear.app/ecard/comment/${input.id}` } } };
    },
    TicketCommentUpdate: (v: Vars) => {
      const c = this.comments.get(String(v["id"]));
      if (c) Object.assign(c, v["input"], { updatedAt: this.now() });
      return { commentUpdate: { success: true } };
    },
    TicketCommentDelete: (v: Vars) => {
      for (const c of [...this.comments.values()]) if (c.id === v["id"] || c.parentId === v["id"]) this.comments.delete(c.id);
      return { commentDelete: { success: true } };
    },
    TicketCommentResolve: (v: Vars) => {
      const c = this.comments.get(String(v["id"]));
      if (c) c.resolvedAt = this.now();
      return { commentResolve: { success: true } };
    },
    TicketCommentUnresolve: (v: Vars) => {
      const c = this.comments.get(String(v["id"]));
      if (c) c.resolvedAt = null;
      return { commentUnresolve: { success: true } };
    },
    TicketReactionCreate: (v: Vars) => {
      const input = v["input"] as { id: string; commentId: string; emoji: string };
      this.comments.get(input.commentId)?.reactions.push({ id: input.id, emoji: input.emoji, userId: ME });
      return { reactionCreate: { success: true, reaction: { id: input.id } } };
    },
    TicketReactionDelete: (v: Vars) => {
      for (const c of this.comments.values()) c.reactions = c.reactions.filter((r) => r.id !== v["id"]);
      return { reactionDelete: { success: true } };
    },
  };
}

/**
 * Linear over HTTP as `linearGql` sees it: the fake's answer as a 200, or (`serverError`) the
 * operation applied and then a 503 with a GraphQL `errors` body.
 */
function httpOver(linear: FakeLinear, serverError: (op: string) => boolean) {
  return async (_url: string, init?: RequestInit): Promise<Response> => {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Vars };
    const data = await linear.gql(query, variables);
    const op = /^(?:query|mutation) (\w+)/.exec(query)?.[1] ?? "";
    if (serverError(op)) return new Response(JSON.stringify({ errors: [{ message: "Internal server error" }] }), { status: 503 });
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
}

function setup(writes = true, serverError?: (op: string) => boolean) {
  const linear = new FakeLinear();
  const exec = linearExecutor(serverError === undefined ? linear.gql : linearGql(() => "lin_api_test", httpOver(linear, serverError)), () => ME);
  const dir = mkdtempSync(join(tmpdir(), "tickets-linear-"));
  const gate = new MutationGate({ dir, writesEnabled: () => writes, pin: () => ({ viewerId: ME, generation: 1, linear: exec }), current: () => true, now: () => T0, log: () => undefined });
  return { linear, exec, gate, dir };
}

/** prepare + commit, as the confirm does. */
async function confirmAndCommit(gate: MutationGate, mutation: TicketMutation, opId: string) {
  const prepared = await gate.prepare(DEVICE, mutation, ACTOR);
  if (prepared.approval === undefined) return prepared;
  return gate.commit(DEVICE, { approvalId: prepared.approval.id, opId, mutation }, ACTOR);
}

const CREATE_ISSUE: TicketMutation = { kind: "createIssue", teamId: "t-1", stateId: "s-todo", templateId: null, projectId: "p-1", title: "Follow up", description: "From a comment", sourceCommentId: "c-root", referenceCommentId: "c-root" };
const EVERY_KIND: readonly TicketMutation[] = [
  { kind: "setState", issueId: "issue-1", fromStateId: "s-todo", toStateId: "s-done" },
  { kind: "comment", issueId: "issue-1", body: "Hi" },
  { kind: "editComment", commentId: "c-mine", body: "Edited" },
  { kind: "deleteComment", commentId: "c-mine", replyCount: 0 },
  { kind: "resolve", rootId: "c-root", on: true },
  { kind: "react", commentId: "c-root", emoji: "+1", on: true },
  { kind: "subscribe", issueId: "issue-1", on: false },
  CREATE_ISSUE,
  { kind: "applyPlan", rows: [{ key: "ENG-1", issueId: "issue-1", opId: ROW_A, baseUpdatedAt: T0, priority: 2 }] },
];

describe("linearExecutor checks", () => {
  it("refuses a move whose live state isn't the from-state, or whose target isn't in the team", async () => {
    const { exec, linear } = setup();
    linear.issues.get("issue-1")!.stateId = "s-doing";
    expect(await exec.check({ kind: "setState", issueId: "issue-1", fromStateId: "s-todo", toStateId: "s-done" })).toEqual({
      ok: false,
      code: "conflict",
      message: "Changed in Linear since you looked: ENG-1 is in In Progress now",
    });
    expect(await exec.check({ kind: "setState", issueId: "issue-1", fromStateId: "s-doing", toStateId: "s-other" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await exec.check({ kind: "setState", issueId: "issue-1", fromStateId: "s-doing", toStateId: "s-done" })).toEqual({ ok: true, revision: "s-doing", summary: "Move ENG-1 to Done", toStateType: "completed" });
    expect(await exec.check({ kind: "setState", issueId: "gone", fromStateId: "s-doing", toStateId: "s-done" })).toMatchObject({ ok: false, code: "invalid" });
  });

  it("refuses editing or deleting someone else's comment, a reply to a reply and resolving a reply", async () => {
    const { exec } = setup();
    expect(await exec.check({ kind: "editComment", commentId: "c-root", body: "x" })).toMatchObject({ ok: false, code: "invalid", message: "You can only edit your own comments" });
    expect(await exec.check({ kind: "deleteComment", commentId: "c-root", replyCount: 1 })).toMatchObject({ ok: false, code: "invalid" });
    expect(await exec.check({ kind: "comment", issueId: "issue-1", parentId: "c-mine", body: "x" })).toMatchObject({ ok: false, code: "invalid", message: "Replies go to the thread's first comment" });
    expect(await exec.check({ kind: "comment", issueId: "issue-2", parentId: "c-root", body: "x" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await exec.check({ kind: "resolve", rootId: "c-mine", on: true })).toMatchObject({ ok: false, code: "invalid" });
  });

  it("refuses deleting a root whose reply count changed since Isaac was told", async () => {
    const { exec, linear } = setup();
    linear.addComment({ id: "c-reply", issueId: "issue-1", parentId: "c-own-root", userId: "viewer-nova", body: "?" });
    expect(await exec.check({ kind: "deleteComment", commentId: "c-own-root", replyCount: 0 })).toMatchObject({ ok: false, code: "conflict" });
    expect(await exec.check({ kind: "deleteComment", commentId: "c-own-root", replyCount: 1 })).toMatchObject({ ok: true, summary: "Delete your comment and its 1 replies" });
  });

  it("refuses a new issue in a state outside the team, or in an unknown team", async () => {
    const { exec } = setup();
    expect(await exec.check({ ...CREATE_ISSUE, stateId: "s-x" } as TicketMutation)).toMatchObject({ ok: false, code: "invalid" });
    expect(await exec.check({ ...CREATE_ISSUE, teamId: "t-x" } as TicketMutation)).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("linearExecutor writes through the gate", () => {
  it("refuses every kind with zero Linear calls when writes are off", async () => {
    const { gate, linear } = setup(false);
    for (const m of EVERY_KIND) {
      expect((await gate.prepare(DEVICE, m, ACTOR)).refused?.code).toBe("writesOff");
      expect((await gate.commit(DEVICE, { opId: OP1, mutation: m }, ACTOR)).refused?.code).toBe("writesOff");
    }
    expect(linear.calls).toEqual([]);
  });

  it("needs an approval to move into Done but moves to In Progress directly", async () => {
    const { gate, linear } = setup();
    const done: TicketMutation = { kind: "setState", issueId: "issue-1", fromStateId: "s-todo", toStateId: "s-done" };
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: done }, ACTOR)).refused?.code).toBe("approval");
    const res = await gate.commit(DEVICE, { opId: OP2, mutation: { ...done, toStateId: "s-doing" } }, ACTOR);
    expect(res.outcome).toEqual({ opId: OP2, state: "done", result: { id: "issue-1", key: "ENG-1", url: "https://linear.app/ecard/issue/ENG-1" } });
    expect(linear.mutations()).toEqual([{ op: "TicketIssueUpdate", vars: { id: "issue-1", input: { stateId: "s-doing" } } }]);
  });

  it("posts a reply with id = opId, and reconciles a lost response by that id without posting twice", async () => {
    const { gate, linear } = setup();
    const reply: TicketMutation = { kind: "comment", issueId: "issue-1", parentId: "c-root", body: "Done, see PR" };
    linear.fault = (op) => (op === "TicketCommentCreate" ? "lost" : undefined);
    expect((await confirmAndCommit(gate, reply, OP1)).outcome).toEqual({ opId: OP1, state: "unknown", result: { error: "socket hang up" } });
    linear.fault = () => undefined;
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: reply }, ACTOR)).outcome).toEqual({ opId: OP1, state: "done" });
    expect(linear.mutations()).toEqual([{ op: "TicketCommentCreate", vars: { input: { id: OP1, issueId: "issue-1", parentId: "c-root", quotedText: undefined, body: "Done, see PR" } } }]);
    expect(linear.calls.at(-1)).toEqual({ op: "TicketCommentExists", vars: { id: OP1 } });
  });

  it("posts an inline comment on the description by documentContentId and quotedText", async () => {
    const { gate, linear } = setup();
    const inline: TicketMutation = { kind: "comment", issueId: "issue-1", documentContentId: "doc-1", quotedText: "the API", body: "Which one?" };
    expect((await confirmAndCommit(gate, inline, OP1)).outcome?.state).toBe("done");
    expect(linear.mutations()[0]?.vars).toEqual({ input: { id: OP1, documentContentId: "doc-1", quotedText: "the API", body: "Which one?" } });
  });

  it("creates an issue with id = opId and reconciles a lost create by reading that id", async () => {
    const { gate, linear } = setup();
    linear.fault = (op) => (op === "TicketIssueCreate" ? "lost" : undefined);
    expect((await confirmAndCommit(gate, CREATE_ISSUE, OP1)).outcome?.state).toBe("unknown");
    linear.fault = () => undefined;
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: CREATE_ISSUE }, ACTOR)).outcome?.state).toBe("done");
    expect(linear.mutations()).toEqual([
      { op: "TicketIssueCreate", vars: { input: { id: OP1, teamId: "t-1", stateId: "s-todo", projectId: "p-1", title: "Follow up", description: "From a comment", sourceCommentId: "c-root", referenceCommentId: "c-root" } } },
    ]);
    expect(linear.calls.at(-1)).toEqual({ op: "TicketIssueExists", vars: { id: OP1 } });
  });

  it("edits and deletes own comments", async () => {
    const { gate, linear } = setup();
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: { kind: "editComment", commentId: "c-mine", body: "On it now" } }, ACTOR)).outcome?.state).toBe("done");
    expect((await confirmAndCommit(gate, { kind: "deleteComment", commentId: "c-mine", replyCount: 0 }, OP2)).outcome?.state).toBe("done");
    expect(linear.mutations().map((c) => c.op)).toEqual(["TicketCommentUpdate", "TicketCommentDelete"]);
    expect(linear.comments.has("c-mine")).toBe(false);
  });

  it("sets reactions, resolve and subscription as desired state, no-op when already so", async () => {
    const { gate, linear } = setup();
    const react: TicketMutation = { kind: "react", commentId: "c-root", emoji: "+1", on: true };
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: react }, ACTOR)).outcome?.state).toBe("done");
    expect(linear.mutations()).toEqual([{ op: "TicketReactionCreate", vars: { input: { id: OP1, commentId: "c-root", emoji: "+1" } } }]);
    expect((await gate.commit(DEVICE, { opId: OP2, mutation: react }, ACTOR)).outcome?.state).toBe("done");
    expect(linear.mutations()).toHaveLength(1);
    const ops = ["6d796135-613d-4bd8-ae3f-d928a50f7541", "6d796135-613d-4bd8-ae3f-d928a50f7542", "6d796135-613d-4bd8-ae3f-d928a50f7543", "6d796135-613d-4bd8-ae3f-d928a50f7544"];
    await gate.commit(DEVICE, { opId: ops[0]!, mutation: { ...react, on: false } }, ACTOR);
    await gate.commit(DEVICE, { opId: ops[1]!, mutation: { kind: "subscribe", issueId: "issue-1", on: true } }, ACTOR);
    await gate.commit(DEVICE, { opId: ops[2]!, mutation: { kind: "resolve", rootId: "c-root", on: true } }, ACTOR);
    await gate.commit(DEVICE, { opId: ops[3]!, mutation: { kind: "resolve", rootId: "c-root", on: true } }, ACTOR);
    expect(linear.mutations().map((c) => c.op)).toEqual(["TicketReactionCreate", "TicketReactionDelete", "TicketCommentResolve"]);
    expect(linear.mutations("TicketReactionDelete")[0]?.vars).toEqual({ id: OP1 });
  });

  it("reconciles a lost reaction by reading the comment's reactions", async () => {
    const { exec, linear } = setup();
    const react: TicketMutation = { kind: "react", commentId: "c-root", emoji: "+1", on: true };
    expect(await exec.reconcile(react, OP1, T0)).toBe("notDone");
    await exec.run(react, OP1);
    expect(await exec.reconcile(react, OP1, T0)).toBe("done");
    expect(linear.mutations()).toHaveLength(1);
  });

  it("takes a 5xx with a GraphQL errors body as unknown, and the retry finds the comment instead of posting twice", async () => {
    let failed = false;
    const { gate, linear } = setup(true, (op) => op === "TicketCommentCreate" && !failed && (failed = true));
    const reply: TicketMutation = { kind: "comment", issueId: "issue-1", parentId: "c-root", body: "Done, see PR" };
    const first = await confirmAndCommit(gate, reply, OP1);
    expect(first.outcome?.state).toBe("unknown");
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: reply }, ACTOR)).outcome?.state).toBe("done");
    expect(linear.mutations("TicketCommentCreate")).toHaveLength(1);
  });

  it("never reapplies a move answered 5xx after someone moved the issue back", async () => {
    let failed = false;
    const { gate, linear } = setup(true, (op) => op === "TicketIssueUpdate" && !failed && (failed = true));
    const move: TicketMutation = { kind: "setState", issueId: "issue-1", fromStateId: "s-todo", toStateId: "s-doing" };
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: move }, ACTOR)).outcome?.state).toBe("unknown");
    expect(linear.issues.get("issue-1")?.stateId).toBe("s-doing");
    linear.issues.get("issue-1")!.stateId = "s-todo";
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: move }, ACTOR)).outcome?.state).toBe("unknown");
    expect(linear.mutations("TicketIssueUpdate")).toHaveLength(1);
  });
});

describe("applyPlan", () => {
  const plan = (rows: { key: string; issueId: string; opId: string; priority: number }[]): TicketMutation => ({
    kind: "applyPlan",
    rows: rows.map((r) => ({ ...r, baseUpdatedAt: T0 })),
  });
  const rows = [
    { key: "ENG-1", issueId: "issue-1", opId: ROW_A, priority: 1 },
    { key: "ENG-2", issueId: "issue-2", opId: ROW_B, priority: 2 },
    { key: "ENG-3", issueId: "issue-3", opId: ROW_C, priority: 3 },
  ];

  it("keeps per-row outcomes on a partial failure; a retry with the same row opIds doesn't rewrite succeeded rows", async () => {
    const { gate, linear } = setup();
    linear.issues.get("issue-2")!.updatedAt = new Date(T0 + 5000).toISOString();
    linear.fault = (op, v) => (op === "TicketIssueUpdate" && v["id"] === "issue-3" ? "reject" : undefined);
    const first = await confirmAndCommit(gate, plan(rows), OP1);
    expect(first.outcome).toEqual({
      opId: OP1,
      state: "failed",
      result: {
        rows: [
          { key: "ENG-1", opId: ROW_A, state: "done" },
          { key: "ENG-2", opId: ROW_B, state: "failed", error: "Changed in Linear since the plan was made" },
          { key: "ENG-3", opId: ROW_C, state: "failed", error: "Linear refused issueUpdate" },
        ],
      },
    });
    expect(first).toMatchObject({ ok: false, error: "Not every change was written" });
    linear.fault = () => undefined;
    const retry = await confirmAndCommit(gate, plan([rows[0]!, rows[2]!]), OP2);
    expect(retry.outcome?.state).toBe("done");
    expect(retry.outcome?.result?.rows?.map((r) => [r.opId, r.state])).toEqual([
      [ROW_A, "done"],
      [ROW_C, "done"],
    ]);
    const writes = linear.mutations("TicketIssueUpdate").map((c) => c.vars["id"]);
    expect(writes).toEqual(["issue-1", "issue-3", "issue-3"]);
    expect(linear.mutations("TicketIssueUpdate").filter((c) => c.vars["id"] === "issue-1")).toHaveLength(1);
    expect(linear.issues.get("issue-3")!.priority).toBe(3);
  });

  it("answers the stored outcome for the same opId and reconciles a lost row write without rewriting it", async () => {
    const { gate, linear } = setup();
    linear.fault = (op, v) => (op === "TicketIssueUpdate" && v["id"] === "issue-2" ? "lost" : undefined);
    const first = await confirmAndCommit(gate, plan(rows), OP1);
    expect(first.outcome?.state).toBe("unknown");
    linear.fault = () => undefined;
    expect((await gate.commit(DEVICE, { opId: OP1, mutation: plan(rows) }, ACTOR)).outcome?.state).toBe("done");
    expect(linear.mutations("TicketIssueUpdate").map((c) => c.vars["id"])).toEqual(["issue-1", "issue-2", "issue-3"]);
  });

  it("refuses a plan naming an issue that's gone", async () => {
    const { gate, linear } = setup();
    const res = await gate.prepare(DEVICE, plan([{ key: "ENG-9", issueId: "issue-9", opId: ROW_A, priority: 1 }]), ACTOR);
    expect(res.refused?.code).toBe("invalid");
    expect(linear.mutations()).toEqual([]);
  });
});
