import { describe, expect, it } from "vitest";
import { ReviewPr } from "@relay/protocol";
import type { ToolResult, ToolRun } from "../src/reviews/exec";
import { GitHub, type GhGraphql, type RawPr } from "../src/reviews/github";
import { readPrReactions } from "../src/reviews/pr-reactions";

const ok = (stdout = ""): ToolResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const graphqlOf =
  (repository: unknown): GhGraphql =>
  () =>
    Promise.resolve({ data: { repository }, errors: [] });

const group = (content: string, logins: string[]): Record<string, unknown> => ({ content, reactors: { nodes: logins.map((login) => ({ login })) } });

const PR = {
  pullRequest: {
    reactionGroups: [group("HOORAY", ["noah"]), group("EYES", [])],
    comments: {
      nodes: [
        { databaseId: 101, reactionGroups: [group("THUMBS_UP", ["iweber", "todd"]), group("NOT_AN_EMOJI", ["x"])] },
        { databaseId: 102, reactionGroups: [] },
        { databaseId: null, reactionGroups: [group("HEART", ["x"])] },
      ],
    },
  },
};

const RAW: RawPr = {
  number: 7,
  title: "T",
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  isDraft: false,
  author: { login: "todd" },
  createdAt: "2026-10-30T09:00:00Z",
  updatedAt: "2026-10-30T12:00:00Z",
  body: "b",
  baseRefName: "main",
  baseRefOid: "b".repeat(40),
  headRefName: "feat",
  headRefOid: "a".repeat(40),
  additions: 1,
  deletions: 0,
  commits: [],
  files: [],
  reviewRequests: [],
  latestReviews: [],
  reviews: [],
  comments: [
    { author: { login: "todd" }, body: "first", createdAt: "2026-10-30T10:00:00Z", url: "https://github.com/o/r/pull/7#issuecomment-101" },
    { author: { login: "noah" }, body: "second", createdAt: "2026-10-30T11:00:00Z", url: "https://github.com/o/r/pull/7#issuecomment-102" },
    { author: { login: "sam" }, body: "no url", createdAt: "2026-10-30T11:30:00Z" },
  ],
  assignees: [],
  labels: [],
  statusCheckRollup: [],
};

describe("PR reactions", () => {
  it("reads who reacted to the body and each comment, by REST id, with unicode emoji", async () => {
    const r = await readPrReactions(graphqlOf(PR), "o/r", 7);
    expect(r?.body).toEqual([{ emoji: "🎉", users: ["noah"] }]);
    expect(r?.comments.get(101)).toEqual([{ emoji: "👍", users: ["iweber", "todd"] }]);
    expect(r?.comments.get(102)).toEqual([]);
    expect(r?.comments.size).toBe(2);
  });

  it("answers null for a PR GitHub doesn't resolve and throws on another shape", async () => {
    expect(await readPrReactions(graphqlOf(null), "o/r", 7)).toBeNull();
    await expect(readPrReactions(graphqlOf({ pullRequest: { comments: 3 } }), "o/r", 7)).rejects.toThrow(/something else/);
  });

  it("puts comment ids and reactions on the PR read with one budgeted graphql call, and leaves reactions out when GitHub can't say", async () => {
    const calls: string[] = [];
    const answer =
      (reactions: boolean): ToolRun =>
      (argv) => {
        const query = argv.find((a) => a.startsWith("query=")) ?? "";
        if (argv.includes("view")) return Promise.resolve(ok(JSON.stringify(RAW)));
        if (argv.some((a) => a.includes("/compare/"))) return Promise.resolve(ok(""));
        const mine = query.includes("comments(last:");
        if (mine) calls.push("reactions");
        if (!mine) return Promise.resolve(ok(`HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ data: { repository: null } })}`));
        if (!reactions) return Promise.resolve({ code: 1, stdout: "", stderr: "boom", timedOut: false });
        return Promise.resolve(ok(`HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ data: { repository: PR } })}`));
      };
    const pr = await new GitHub(answer(true), "gh", undefined, null, () => true).pr("o/r", 7);
    expect(calls).toEqual(["reactions"]);
    expect(pr.bodyReactions).toEqual([{ emoji: "🎉", users: ["noah"] }]);
    const comments = pr.timeline.filter((t) => t.kind === "comment");
    expect(comments.map((c) => c.id)).toEqual([101, 102, undefined]);
    expect(comments[0]?.reactions).toEqual([{ emoji: "👍", users: ["iweber", "todd"] }]);
    expect(comments[2]?.reactions).toBeUndefined();
    expect(ReviewPr.safeParse(pr).success).toBe(true);

    const without = await new GitHub(answer(false), "gh", undefined, null, () => true).pr("o/r", 7);
    expect(without.bodyReactions).toBeUndefined();
    expect(without.timeline.filter((t) => t.kind === "comment").map((c) => c.id)).toEqual([101, 102, undefined]);
  });
});
