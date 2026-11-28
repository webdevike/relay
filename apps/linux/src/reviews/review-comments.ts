// A PR's review (line) comments for the Diff tab's inline threads and the Comments tab: one GraphQL
// read per PR read (review threads with their outdated flag, place, replies and who reacted).

import { MAX_REVIEW_COMMENTS, type ReviewComment } from "@relay/protocol";
import { z } from "zod";
import type { GhGraphql } from "./github";

const THREADS = 100;
const COMMENTS = 30;
const REACTORS = 10;

/** GitHub's reaction content as the emoji Relay shows. */
const EMOJI: Record<string, string> = {
  THUMBS_UP: "👍",
  THUMBS_DOWN: "👎",
  LAUGH: "😄",
  HOORAY: "🎉",
  CONFUSED: "😕",
  HEART: "❤️",
  ROCKET: "🚀",
  EYES: "👀",
};

export function reviewThreadsQuery(repo: string, number: number): string {
  const [owner = "", name = ""] = repo.split("/");
  return `{ repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${String(number)}) {
  reviewThreads(first: ${String(THREADS)}) { nodes { isOutdated path line originalLine diffSide
    comments(first: ${String(COMMENTS)}) { nodes { databaseId author { login } body createdAt
      reactionGroups { content reactors(first: ${String(REACTORS)}) { nodes { ... on User { login } ... on Bot { login } } } } } } } } } } }`;
}

const Comment = z.object({
  databaseId: z.number().int(),
  author: z.object({ login: z.string() }).nullable(),
  body: z.string(),
  createdAt: z.string(),
  reactionGroups: z
    .array(z.object({ content: z.string(), reactors: z.object({ nodes: z.array(z.object({ login: z.string().optional() })) }) }))
    .nullable()
    .optional(),
});
const Thread = z.object({
  isOutdated: z.boolean(),
  path: z.string(),
  line: z.number().int().nullable(),
  originalLine: z.number().int().nullable(),
  diffSide: z.enum(["LEFT", "RIGHT"]),
  comments: z.object({ nodes: z.array(Comment) }),
});
const Answer = z.object({ pullRequest: z.object({ reviewThreads: z.object({ nodes: z.array(Thread) }) }).nullable() }).nullable();

function reactionsOf(c: z.infer<typeof Comment>): NonNullable<ReviewComment["reactions"]> {
  return (c.reactionGroups ?? []).flatMap((g) => {
    const users = g.reactors.nodes.flatMap((n) => (n.login === undefined ? [] : [n.login]));
    const emoji = EMOJI[g.content];
    return emoji === undefined || users.length === 0 ? [] : [{ emoji, users }];
  });
}

/** A thread's comments as protocol review comments: every reply points at the thread's first comment. */
function threadComments(t: z.infer<typeof Thread>): ReviewComment[] {
  const root = t.comments.nodes[0]?.databaseId ?? null;
  return t.comments.nodes.map((c) => ({
    id: c.databaseId,
    inReplyTo: c.databaseId === root ? null : root,
    path: t.path,
    line: t.isOutdated ? null : t.line,
    originalLine: t.originalLine,
    side: t.diffSide,
    outdated: t.isOutdated,
    author: c.author?.login ?? "ghost",
    body: c.body,
    at: Date.parse(c.createdAt) || 0,
    reactions: reactionsOf(c),
  }));
}

/** The PR's review comments, oldest first, at most MAX_REVIEW_COMMENTS. Throws when GitHub can't say. */
export async function readReviewComments(graphql: GhGraphql, repo: string, number: number): Promise<ReviewComment[]> {
  const { data } = await graphql(reviewThreadsQuery(repo, number));
  const parsed = Answer.safeParse(data["repository"] ?? null);
  if (!parsed.success) throw new Error(`GitHub answered something else for ${repo}#${String(number)} review threads`);
  const threads = parsed.data?.pullRequest?.reviewThreads.nodes ?? [];
  return threads
    .flatMap(threadComments)
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_REVIEW_COMMENTS);
}
