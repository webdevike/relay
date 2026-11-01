// Linear in Reviews (evaos-electron linear-inbox.ts): tickets that want Isaac (his notifications:
// mentions, comments and replies, from other people, on tickets still open) and one ticket's details
// and comment threads, read from Linear's GraphQL API with his key (LINEAR_API_KEY or
// `<agent home>/secrets/linear.env`). Images uploaded to Linear need that key, so the host downloads
// them once (`ReviewMedia`) and the markdown points at `/reviews/media/<file>/<token>` on the host.
// Writes, after Isaac confirms: posting a comment, and uploading an image for one (`upload`).

import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LinearTicket, ReviewItem } from "@relay/protocol";
import { z } from "zod";
import { sameToken } from "../drops/serve";
import type { DropBlob } from "../seams";

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/** `LINEAR_API_KEY`, else `secrets/linear.env` in the agent home (as EvaOS's linear source). */
export function linearKey(agentHome: string | null): string | null {
  const env = process.env["LINEAR_API_KEY"];
  if (env !== undefined && env !== "") return env;
  if (agentHome === null) return null;
  let text = "";
  try {
    text = readFileSync(join(agentHome, "secrets", "linear.env"), "utf8");
  } catch {
    return null;
  }
  const m = /^\s*(?:export\s+)?LINEAR_API_KEY\s*=\s*["']?([^"'\s]+)/m.exec(text);
  return m?.[1] ?? null;
}

const User = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  /** The profile page; a link to it in a comment is a mention. */
  url: z.string().optional(),
});

export const QueueData = z.object({
  viewer: User,
  notifications: z.object({
    nodes: z.array(
      z.object({
        type: z.string(),
        createdAt: z.string(),
        readAt: z.string().nullable(),
        archivedAt: z.string().nullable(),
        actor: User.nullable().optional(),
        issue: z
          .object({
            identifier: z.string(),
            title: z.string(),
            url: z.string(),
            state: z.object({ type: z.string() }),
            comments: z
              .object({
                nodes: z.array(
                  z.object({
                    createdAt: z.string(),
                    user: z.object({ id: z.string() }).nullable(),
                  }),
                ),
              })
              .optional(),
          })
          .nullable()
          .optional(),
      }),
    ),
  }),
});

const QUEUE_QUERY = `{
  viewer { id name displayName }
  notifications(first: 100) { nodes {
    type createdAt readAt archivedAt actor { id name displayName }
    ... on IssueNotification { issue {
      identifier title url state { type }
      comments(last: 20) { nodes { createdAt user { id } } }
    } }
  } }
}`;

export interface LinearRow {
  key: string;
  title: string;
  url: string;
  reason: string;
  actor: string;
  updatedAt: number;
  unread: boolean;
  /** The ticket's workflow state type (`started`, `unstarted`, ...). */
  stateType: string;
}

/**
 * Notification types that want an answer from Isaac, and how a row says so: an @mention, or a
 * comment or reply on a ticket or thread he follows. Assignments and status changes are not asks.
 */
export function reasonOf(type: string): string | null {
  if (type === "issueCommentMention" || type === "issueMention") return "mentioned you";
  if (type === "issueNewComment") return "commented";
  if (/Reply|Thread/.test(type)) return "replied";
  return null;
}

/**
 * One row per ticket that still wants Isaac: the newest ask from someone else, newest first. A
 * ticket leaves once he has commented since that ask (a reply anywhere on it), and comes back with
 * the next ask.
 */
export function toRows(data: z.infer<typeof QueueData>): LinearRow[] {
  const rows = new Map<string, LinearRow>();
  for (const n of data.notifications.nodes) {
    const reason = reasonOf(n.type);
    const issue = n.issue;
    if (!reason || !issue || n.archivedAt) continue;
    // His own agents post as him; those are not asks. Nor is a finished ticket.
    if (n.actor?.id === data.viewer.id) continue;
    if (issue.state.type === "completed" || issue.state.type === "canceled") continue;
    const at = ms(n.createdAt);
    const prev = rows.get(issue.identifier);
    if (prev && prev.updatedAt >= at) {
      prev.unread ||= n.readAt === null;
      continue;
    }
    const lastMine = Math.max(
      0,
      ...(issue.comments?.nodes ?? []).filter((c) => c.user?.id === data.viewer.id).map((c) => ms(c.createdAt)),
    );
    // He has commented since this ask (and so since every older one): it is answered.
    if (lastMine >= at) continue;
    rows.set(issue.identifier, {
      key: issue.identifier,
      title: issue.title,
      url: issue.url,
      reason,
      actor: n.actor?.name ?? "Linear",
      updatedAt: at,
      unread: n.readAt === null || (prev?.unread ?? false),
      stateType: issue.state.type,
    });
  }
  return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function linearItem(row: LinearRow): ReviewItem {
  return {
    url: row.url,
    ref: { kind: "linear", key: row.key },
    title: row.title,
    actor: row.actor,
    reason: row.reason,
    label: row.key,
    updatedAt: row.updatedAt,
    unread: row.unread,
    stateType: row.stateType,
  };
}

const Ticket = z.object({
  viewer: User,
  issue: z.object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    url: z.string(),
    description: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    priorityLabel: z.string(),
    creator: User.nullable(),
    state: z.object({ name: z.string(), type: z.string(), color: z.string() }),
    assignee: User.nullable(),
    team: z.object({ name: z.string() }),
    labels: z.object({ nodes: z.array(z.object({ name: z.string(), color: z.string() })) }),
    project: z.object({ name: z.string() }).nullable(),
    parent: z.object({ identifier: z.string(), title: z.string(), url: z.string() }).nullable(),
    children: z.object({
      nodes: z.array(
        z.object({
          identifier: z.string(),
          title: z.string(),
          url: z.string(),
          state: z.object({ name: z.string() }),
        }),
      ),
    }),
    attachments: z.object({
      nodes: z.array(z.object({ title: z.string(), url: z.string(), sourceType: z.string().nullable() })),
    }),
    comments: z.object({
      nodes: z.array(
        z.object({
          id: z.string(),
          body: z.string(),
          createdAt: z.string(),
          url: z.string(),
          user: User.nullable(),
          parent: z.object({ id: z.string() }).nullable(),
        }),
      ),
    }),
    history: z.object({
      nodes: z.array(
        z.object({
          createdAt: z.string(),
          actor: z.object({ name: z.string() }).nullable(),
          fromState: z.object({ name: z.string() }).nullable(),
          toState: z.object({ name: z.string() }).nullable(),
        }),
      ),
    }),
  }),
});

const TICKET_QUERY = `query($id: String!) {
  viewer { id name displayName url }
  issue(id: $id) {
    id identifier title url description createdAt updatedAt priorityLabel
    creator { id name displayName url }
    state { name type color } assignee { id name displayName url } team { name }
    labels { nodes { name color } } project { name }
    parent { identifier title url }
    children { nodes { identifier title url state { name } } }
    attachments { nodes { title url sourceType } }
    comments(first: 250) { nodes { id body createdAt url user { id name displayName url } parent { id } } }
    history(first: 100) { nodes { createdAt actor { name } fromState { name } toState { name } } }
  }
}`;

/** Linear's uploaded images in markdown (`![alt](https://uploads.linear.app/...)`). */
const UPLOAD = /!\[([^\]]*)\]\((https:\/\/uploads\.linear\.app\/[^)\s]+)\)/g;
const EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MEDIA_NAME = /^[0-9a-f]{40}\.(png|jpg|gif|webp)$/;

const CommentMade = z.object({
  commentCreate: z.object({
    success: z.boolean(),
    comment: z.object({ url: z.string() }).nullable(),
  }),
});

const UploadMade = z.object({
  fileUpload: z.object({
    success: z.boolean(),
    uploadFile: z
      .object({
        uploadUrl: z.string(),
        assetUrl: z.string(),
        headers: z.array(z.object({ key: z.string(), value: z.string() })),
      })
      .nullable(),
  }),
});

/** A ticket's status changes as activity lines, oldest first; other history (labels, assignees ...) is left out. */
export function toActivity(nodes: z.infer<typeof Ticket>["issue"]["history"]["nodes"]): LinearTicket["activity"] {
  return nodes
    .flatMap((n) => {
      const to = n.toState?.name;
      if (to === undefined || to === n.fromState?.name) return [];
      const from = n.fromState?.name;
      return [
        {
          at: ms(n.createdAt),
          actor: n.actor?.name ?? "Linear",
          text: from === undefined ? `set status to ${to}` : `changed status from ${from} to ${to}`,
          highlights: from === undefined ? [to] : [from, to],
        },
      ];
    })
    .sort((a, b) => a.at - b.at);
}

/**
 * Linear's uploads as files in `dir` (`<sha1 of the url><ext>`), served at
 * `/reviews/media/<file>/<token>`: the token is an HMAC of the file name under a secret that lives
 * as long as this process, so only paths the host handed out (to authenticated devices) open.
 */
export class ReviewMedia {
  private readonly secret = randomBytes(32);

  constructor(readonly dir: string) {}

  token(name: string): string {
    return createHmac("sha256", this.secret).update(name, "utf8").digest("hex").slice(0, 32);
  }

  /** The host-relative path a device prefixes with the host's base URL. */
  path(name: string): string {
    return `/reviews/media/${name}/${this.token(name)}`;
  }

  /** A downloaded file iff `token` is its token; null otherwise. */
  open(name: string, token: string): DropBlob | null {
    if (!MEDIA_NAME.test(name) || !sameToken(this.token(name), token)) return null;
    const file = join(this.dir, name);
    try {
      return { path: file, mimeType: MIME[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream", name, size: statSync(file).size };
    } catch {
      return null;
    }
  }
}

/** The part of `fetch` Linear's reads use (a test seam). */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class Linear {
  constructor(
    private readonly key: () => string | null,
    private readonly media: ReviewMedia,
    private readonly fetchFn: Fetch,
  ) {}

  private async gql(query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
    const token = this.key();
    if (!token) throw new Error("No Linear API key (LINEAR_API_KEY or secrets/linear.env)");
    const res = await this.fetchFn("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Linear answered ${String(res.status)}`);
    const body = z
      .object({
        data: z.unknown().optional(),
        errors: z.array(z.object({ message: z.string() })).optional(),
      })
      .parse(await res.json());
    const first = body.errors?.[0];
    if (first !== undefined) throw new Error(first.message);
    return body.data;
  }

  /** A Linear upload as a host path (downloaded once with the key); the URL itself on failure. */
  private async localImage(url: string): Promise<string> {
    const sha = createHash("sha1").update(url).digest("hex");
    const have = existsSync(this.media.dir) ? readdirSync(this.media.dir).find((f) => f.startsWith(`${sha}.`)) : undefined;
    if (have !== undefined) return this.media.path(have);
    try {
      const token = this.key();
      const res = await this.fetchFn(url, { headers: token ? { authorization: token } : {}, signal: AbortSignal.timeout(20_000) });
      const ext = EXT[(res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? ""];
      if (!res.ok || ext === undefined) return url;
      mkdirSync(this.media.dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(this.media.dir, `${sha}${ext}`), Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
      return this.media.path(`${sha}${ext}`);
    } catch {
      return url;
    }
  }

  private async withLocalImages(md: string): Promise<string> {
    const urls = [...new Set([...md.matchAll(UPLOAD)].map((m) => m[2] ?? ""))];
    const local = new Map(await Promise.all(urls.map(async (u) => [u, await this.localImage(u)] as const)));
    return md.replace(UPLOAD, (_, alt: string, url: string) => `![${alt}](${local.get(url) ?? url})`);
  }

  async queue(): Promise<LinearRow[]> {
    return toRows(QueueData.parse(await this.gql(QUEUE_QUERY)));
  }

  async ticket(key: string): Promise<LinearTicket> {
    const { viewer, issue: i } = Ticket.parse(await this.gql(TICKET_QUERY, { id: key }));
    // A mention Linear understands is a link to the person's profile; `@handle` text is not one.
    const workspace = /^https:\/\/linear\.app\/[^/]+/.exec(i.url)?.[0] ?? "https://linear.app";
    const person = (u: z.infer<typeof User>): LinearTicket["me"] => ({
      name: u.name,
      handle: u.displayName,
      url: u.url ?? `${workspace}/profiles/${u.displayName}`,
    });
    const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mine = new RegExp(`(^|[^\\w])@${esc(viewer.displayName)}\\b|${esc(person(viewer).url)}(?![\\w-])`, "i");
    const comments = await Promise.all(
      [...i.comments.nodes]
        .sort((a, b) => ms(a.createdAt) - ms(b.createdAt))
        .map(async (c) => ({
          id: c.id,
          parentId: c.parent?.id ?? null,
          author: c.user ? person(c.user) : { name: "Linear", handle: "linear", url: "" },
          body: await this.withLocalImages(c.body),
          at: ms(c.createdAt),
          url: c.url,
          mentionsMe: mine.test(c.body),
        })),
    );
    const people = new Map<string, LinearTicket["me"]>();
    for (const u of [i.creator, i.assignee, ...i.comments.nodes.map((c) => c.user)]) {
      if (u && u.id !== viewer.id) people.set(u.id, person(u));
    }
    return {
      id: i.id,
      key: i.identifier,
      title: i.title,
      url: i.url,
      description: await this.withLocalImages(i.description ?? ""),
      creator: i.creator?.name ?? "Linear",
      createdAt: ms(i.createdAt),
      updatedAt: ms(i.updatedAt),
      state: i.state,
      assignee: i.assignee?.name ?? null,
      priority: i.priorityLabel,
      labels: i.labels.nodes,
      project: i.project?.name ?? null,
      team: i.team.name,
      parent: i.parent ? { key: i.parent.identifier, title: i.parent.title, url: i.parent.url } : null,
      children: i.children.nodes.map((c) => ({ key: c.identifier, title: c.title, url: c.url, state: c.state.name })),
      links: i.attachments.nodes.map((a) => ({ title: a.title, url: a.url, kind: a.sourceType ?? "link" })),
      comments,
      activity: toActivity(i.history.nodes),
      people: [...people.values()],
      me: person(viewer),
    };
  }

  /** Posts exactly `body` (a reply under `parentId` when set); answers where it landed. */
  async comment(issueId: string, parentId: string | null, body: string): Promise<string> {
    const data = CommentMade.parse(
      await this.gql(`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { url } } }`, {
        input: { issueId, body, ...(parentId ? { parentId } : {}) },
      }),
    );
    if (!data.commentCreate.success || !data.commentCreate.comment) throw new Error("Linear did not take the comment");
    return data.commentCreate.comment.url;
  }

  /** Uploads an image to Linear's storage (a signed PUT); answers the asset url a comment embeds. */
  async upload(name: string, mime: string, bytes: Uint8Array): Promise<string> {
    const data = UploadMade.parse(
      await this.gql(`mutation($contentType: String!, $filename: String!, $size: Int!) { fileUpload(contentType: $contentType, filename: $filename, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }`, {
        contentType: mime,
        filename: name,
        size: bytes.byteLength,
      }),
    );
    const file = data.fileUpload.uploadFile;
    if (!data.fileUpload.success || file === null) throw new Error("Linear did not take the upload");
    const headers: Record<string, string> = { "content-type": mime, "cache-control": "public, max-age=31536000" };
    for (const h of file.headers) headers[h.key] = h.value;
    const res = await this.fetchFn(file.uploadUrl, { method: "PUT", headers, body: bytes, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Linear's storage answered ${String(res.status)}`);
    return file.assetUrl;
  }
}
