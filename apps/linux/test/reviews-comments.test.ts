import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_REVIEW_COMMENTS, ReviewPr } from "@relay/protocol";
import type { ToolResult, ToolRun } from "../src/reviews/exec";
import { ReviewMedia } from "../src/reviews/linear";
import { GitHub, type GhGraphql, type RawPr } from "../src/reviews/github";
import { readReviewComments } from "../src/reviews/review-comments";

const ok = (stdout = ""): ToolResult => ({ code: 0, stdout, stderr: "", timedOut: false });

const comment = (id: number, at: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  databaseId: id,
  author: { login: "todd" },
  body: `c${String(id)}`,
  createdAt: at,
  reactionGroups: [],
  ...extra,
});

const THREADS = [
  {
    isOutdated: false,
    path: "src/a.ts",
    line: 12,
    originalLine: 10,
    diffSide: "RIGHT",
    comments: {
      nodes: [
        comment(1, "2026-10-30T10:00:00Z", {
          reactionGroups: [
            { content: "THUMBS_UP", reactors: { nodes: [{ login: "iweber" }, { login: "noah" }] } },
            { content: "HEART", reactors: { nodes: [] } },
            { content: "UNKNOWN_KIND", reactors: { nodes: [{ login: "x" }] } },
          ],
        }),
        comment(3, "2026-10-30T12:00:00Z", { author: null }),
      ],
    },
  },
  { isOutdated: true, path: "src/b.ts", line: null, originalLine: 4, diffSide: "LEFT", comments: { nodes: [comment(2, "2026-10-30T11:00:00Z")] } },
];

const graphqlOf =
  (repository: unknown): GhGraphql =>
  () =>
    Promise.resolve({ data: { repository }, errors: [] });

describe("review comments", () => {
  it("maps threads to comments oldest first: replies point at the root, outdated keep their original line, reactions with who", async () => {
    const out = await readReviewComments(graphqlOf({ pullRequest: { reviewThreads: { nodes: THREADS } } }), "o/r", 7);
    expect(out.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(out[0]).toEqual({
      id: 1,
      inReplyTo: null,
      path: "src/a.ts",
      line: 12,
      originalLine: 10,
      side: "RIGHT",
      outdated: false,
      author: "todd",
      body: "c1",
      at: Date.parse("2026-10-30T10:00:00Z"),
      reactions: [{ emoji: "👍", users: ["iweber", "noah"] }],
    });
    expect(out[1]).toMatchObject({ id: 2, inReplyTo: null, line: null, originalLine: 4, side: "LEFT", outdated: true });
    expect(out[2]).toMatchObject({ id: 3, inReplyTo: 1, author: "ghost", path: "src/a.ts", line: 12 });
  });

  it("keeps the newest MAX_REVIEW_COMMENTS", async () => {
    const nodes = Array.from({ length: MAX_REVIEW_COMMENTS + 5 }, (_, i) => ({
      ...THREADS[1],
      comments: { nodes: [comment(i + 1, new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString())] },
    }));
    const out = await readReviewComments(graphqlOf({ pullRequest: { reviewThreads: { nodes } } }), "o/r", 7);
    expect(out).toHaveLength(MAX_REVIEW_COMMENTS);
    expect(out[0]?.id).toBe(6);
  });

  it("answers none for a PR GitHub doesn't resolve and throws on another shape", async () => {
    expect(await readReviewComments(graphqlOf(null), "o/r", 7)).toEqual([]);
    await expect(readReviewComments(graphqlOf({ pullRequest: { reviewThreads: 3 } }), "o/r", 7)).rejects.toThrow(/something else/);
  });

  it("puts them on the PR read with one graphql call, and leaves them out when GitHub can't say", async () => {
    const raw: RawPr = {
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
      files: [{ path: "src/a.ts", additions: 1, deletions: 0 }],
      reviewRequests: [],
      latestReviews: [],
      reviews: [],
      comments: [],
      assignees: [],
      labels: [],
      statusCheckRollup: [],
    };
    const calls: string[] = [];
    const answer = (threads: boolean): ToolRun => (argv) => {
      const query = argv.find((a) => a.startsWith("query=")) ?? "";
      calls.push(query.includes("reviewThreads") ? "threads" : argv.slice(1, 3).join(" "));
      if (argv.includes("view")) return Promise.resolve(ok(JSON.stringify(raw)));
      if (argv.some((a) => a.includes("/compare/"))) return Promise.resolve(ok(""));
      if (!query.includes("reviewThreads")) return Promise.resolve(ok(`HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ data: { repository: null } })}`));
      if (!threads) return Promise.resolve({ code: 1, stdout: "", stderr: "boom", timedOut: false });
      return Promise.resolve(ok(`HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: THREADS } } } } })}`));
    };
    const pr = await new GitHub(answer(true), "gh", undefined, null, () => true).pr("o/r", 7);
    expect(calls.filter((c) => c === "threads")).toHaveLength(1);
    expect(pr.reviewComments?.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(ReviewPr.safeParse(pr).success).toBe(true);
    const without = await new GitHub(answer(false), "gh", undefined, null, () => true).pr("o/r", 7);
    expect(without.reviewComments).toBeUndefined();

    // A review comment's private GitHub image is fetched by the host and served from it: the
    // signed URL never reaches a client.
    const signed = "https://private-user-images.githubusercontent.com/1/line.png?jwt=SECRET.JWT";
    const withImage = [{ ...THREADS[0], comments: { nodes: [comment(9, "2026-10-30T10:00:00Z", { body: `See ![shot](${signed})` })] } }];
    const fetched: string[] = [];
    const fetchFn = (url: string): Promise<Response> => {
      fetched.push(url);
      return Promise.resolve(new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } }));
    };
    const media = new ReviewMedia(join(mkdtempSync(join(tmpdir(), "relay review comments ")), "media"));
    const imaged: ToolRun = (argv, opts) => {
      if (argv.includes("auth")) return Promise.resolve(ok("T\n"));
      const query = argv.find((a) => a.startsWith("query=")) ?? "";
      if (!query.includes("reviewThreads")) return answer(true)(argv, opts);
      return Promise.resolve(ok(`HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: withImage } } } } })}`));
    };
    const local = await new GitHub(imaged, "gh", { media, fetchFn, linearKey: () => null }, null, () => true).pr("o/r", 7);
    expect(fetched).toContain(signed);
    const body = local.reviewComments?.[0]?.body ?? "";
    expect(body).toMatch(/^See !\[shot\]\(\/reviews\/media\/[0-9a-f]{40}\.png\/[0-9a-f]{32}\)$/);
    expect(JSON.stringify(local)).not.toContain("private-user-images");
  });
});
