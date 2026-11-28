// Who reacted to a PR's body and its conversation comments, for the Comments tab's reaction chips
// (hover names, click toggles through the gate's `react`). One GraphQL read per PR read.

import type { ReviewPr } from "@relay/protocol";
import { z } from "zod";
import type { GhGraphql } from "./github";

const COMMENTS = 100;
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

type Reactions = NonNullable<ReviewPr["bodyReactions"]>;

const GROUPS = `reactionGroups { content reactors(first: ${String(REACTORS)}) { nodes { ... on User { login } ... on Bot { login } } } }`;

export function prReactionsQuery(repo: string, number: number): string {
  const [owner = "", name = ""] = repo.split("/");
  return `{ repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${String(number)}) { ${GROUPS}
  comments(last: ${String(COMMENTS)}) { nodes { databaseId ${GROUPS} } } } } }`;
}

const Groups = z
  .array(z.object({ content: z.string(), reactors: z.object({ nodes: z.array(z.object({ login: z.string().optional() })) }) }))
  .nullable()
  .optional();
const Answer = z
  .object({
    pullRequest: z
      .object({ reactionGroups: Groups, comments: z.object({ nodes: z.array(z.object({ databaseId: z.number().int().nullable(), reactionGroups: Groups })) }) })
      .nullable(),
  })
  .nullable();

function reactionsOf(groups: z.infer<typeof Groups>): Reactions {
  return (groups ?? []).flatMap((g) => {
    const users = g.reactors.nodes.flatMap((n) => (n.login === undefined ? [] : [n.login]));
    const emoji = EMOJI[g.content];
    return emoji === undefined || users.length === 0 ? [] : [{ emoji, users }];
  });
}

export interface PrReactions {
  readonly body: Reactions;
  /** By the comment's REST id. */
  readonly comments: ReadonlyMap<number, Reactions>;
}

/** The body's and each conversation comment's reactions; null when the PR doesn't resolve. Throws when GitHub can't say. */
export async function readPrReactions(graphql: GhGraphql, repo: string, number: number): Promise<PrReactions | null> {
  const { data } = await graphql(prReactionsQuery(repo, number));
  const parsed = Answer.safeParse(data["repository"] ?? null);
  if (!parsed.success) throw new Error(`GitHub answered something else for ${repo}#${String(number)} reactions`);
  const pr = parsed.data?.pullRequest ?? null;
  if (pr === null) return null;
  const comments = new Map(pr.comments.nodes.flatMap((c) => (c.databaseId === null ? [] : [[c.databaseId, reactionsOf(c.reactionGroups)] as const])));
  return { body: reactionsOf(pr.reactionGroups), comments };
}

/** `pr` with who reacted to its body and comments (comments by their REST id). */
export function withReactions(pr: ReviewPr, r: PrReactions): ReviewPr {
  const timeline = pr.timeline.map((t) => {
    const reactions = t.id === undefined ? undefined : r.comments.get(t.id);
    return reactions === undefined ? t : { ...t, reactions };
  });
  return { ...pr, bodyReactions: r.body, timeline };
}
