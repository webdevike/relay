// Mines one omp transcript (JSONL) for the artifacts its thread holds. Pure apart from the
// `exists` seam: the service feeds it new bytes of each transcript and merges what it finds.
//
// What counts (from the approved design):
// - Message text of Isaac's turns and the agent's replies; never tool results, omp's custom
//   messages (Eren's rounds list every open ticket) or the persona prime that opens a context.
// - Linear: linear.app/<org>/issue/<KEY> links and bare ENG-1234, keyed by issue key.
// - GitHub: /pull/<n> and /issues/<n> links, `owner/repo#n`, and bare `#n` only against the
//   chat's own repo; other web URLs are links. localhost only when the agent opened it in the
//   browser panel; w3.org namespaces never.
// - Drops (`/drops/<uuid>/<token>`, caption = the embed's alt text) and images Isaac pasted.
// - Files that exist (absolute, `~/`, or Eva-relative), Test Bench runs (work/experiments/<id>),
//   canvases (canvases/<slug>.json, page.open canvas), branches named after a ticket.
// - Subagents from `task` calls, finished by their async result.
// Each message counts an artifact once, however often it repeats it.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize } from "node:path";
import type { ArtifactKind, ArtifactMedia } from "@relay/protocol";

export interface Found {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly url?: string;
  readonly path?: string;
  readonly repo?: string;
  readonly caption?: string;
  readonly media?: ArtifactMedia;
  /** Drop id for `drop` items, so the service can fill in its file facts. */
  readonly drop?: string;
  /** A pasted image's bytes (base64) and type, for the service to store and serve. */
  readonly image?: { readonly sha: string; readonly data: string; readonly mimeType: string };
}

export interface ScannedMessage {
  /** Bubble key: `<role>@<omp timestamp ms>`. */
  readonly key: string;
  readonly role: "user" | "assistant";
  readonly at: number;
  readonly found: readonly Found[];
}

/** A subagent's run ended: its job id as the task tool names it, and how. */
export interface SubagentEnded {
  readonly name: string;
  readonly failed: boolean;
  readonly at: number;
}

export interface ScanResult {
  readonly messages: ScannedMessage[];
  readonly ended: SubagentEnded[];
  /** The session's working directory, from its header line. */
  readonly cwd: string | null;
}

export interface ScanContext {
  /** The transcript file being scanned; subagent transcripts live in `<file minus .jsonl>/`. */
  readonly file: string;
  /** Eva root that Eva-relative paths resolve against; null: they are skipped. */
  readonly evaRoot: string | null;
  /** `owner/name` of the chat's repo: bare `#n` resolves against it; null: bare `#n` is skipped. */
  readonly repo: string | null;
  /** True for a file or directory on disk. */
  readonly exists: (path: string) => boolean;
  /** True while the first user turn of this file is still ahead (it may be the persona prime). */
  readonly fresh: boolean;
}

const DROP = /(?:!\[([^\]\n]{0,300})\]\()?(?:https?:\/\/[^\s/]+)?\/drops\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{64})/g;
const URL_RE = /https?:\/\/[^\s<>"'`)\]}|\\]+/g;
const LINEAR_BARE = /(?<![\w/-])(ENG-\d{3,5})(?![\w-])/g;
const REPO_REF = /(?<![\w/.@-])([A-Za-z0-9][\w.-]{0,38}\/[A-Za-z0-9][\w.-]{0,99})#(\d{1,6})(?!\w)/g;
const BARE_REF = /(?<![\w&/#])#(\d{2,6})(?![\w-])/g;
const ABS_PATH = /(?<![\w/.:~-])((?:~|\/Users\/[^\s/'"`]+|\/tmp|\/private\/tmp)\/[^\s'"`<>()[\]{},;|*?]+)/g;
const EVA_PATH = /(?<![\w/.:~-])((?:work|\.omp|docs|apps|dashboards|workflows|workspaces|recipes|captures|references|jobs|memory)\/[^\s'"`<>()[\]{},;|*?]+)/g;
const BRANCH = /(?<![\w/-])((?:fix|feat|feature|chore|refactor|hotfix|bugfix)\/[A-Za-z]{2,5}-\d+[\w.-]*)/g;
const CANVAS = /canvases\/([a-z0-9][\w-]{0,79})\.json/g;
const CANVAS_PAGE = /"page"\s*:\s*"canvas[:/]([a-z0-9][\w-]{0,79})"/g;
const EXPERIMENT = /work\/experiments\/([A-Za-z0-9][\w.-]{0,99})/;
const EXPERIMENTS = /work\/experiments\/([A-Za-z0-9][\w-]{0,99})/g;
const TRACKING = /^(?:utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|si|igshid)$/i;
const SKIP_HOSTS = /(?:^|\.)w3\.org$|(?:^|\.)schemas?\.(?:org|microsoft\.com)$|^example\.(?:com|org)$/i;
const LOCAL_HOSTS = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w-]+\.local)$/i;
const IMAGE_EXT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/** Characters a URL or path picks up from the prose around it. */
function trimTail(text: string): string {
  return text.replace(/[.,;:!?*_'"`>)\]]+$/, "");
}

/** `Fix-the-login-redirect` -> `Fix the login redirect`. */
function slugTitle(slug: string): string {
  const words = decodeURIComponent(slug).replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The artifact a URL is: a Linear issue, a GitHub PR or issue, a drop, or a plain link with its
 * fragment and tracking parameters stripped. Null for namespaces and (unless `opened`) local hosts.
 */
export function classifyUrl(raw: string, opened = false): Found | null {
  let url: URL;
  try {
    url = new URL(trimTail(raw));
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (SKIP_HOSTS.test(host)) return null;
  if (!opened && LOCAL_HOSTS.test(host)) return null;
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  if (host === "linear.app" && parts[1] === "issue" && parts[2] !== undefined && /^[A-Z][A-Z0-9]{0,9}-\d+$/.test(parts[2])) {
    const key = parts[2];
    const title = parts[3] === undefined ? "" : slugTitle(parts[3]);
    return { id: `linear:${key}`, kind: "linear", title: title === "" ? key : title, url: `https://linear.app/${parts[0]}/issue/${key}` };
  }
  if ((host === "github.com" || host === "www.github.com") && parts.length >= 4 && /^\d+$/.test(parts[3] ?? "")) {
    const repo = `${parts[0]}/${parts[1]}`;
    const n = parts[3] ?? "";
    if (parts[2] === "pull") return { id: `gh-pr:${repo}#${n}`, kind: "gh-pr", title: `${repo}#${n}`, url: `https://github.com/${repo}/pull/${n}`, repo };
    if (parts[2] === "issues") return { id: `gh-issue:${repo}#${n}`, kind: "gh-issue", title: `${repo}#${n}`, url: `https://github.com/${repo}/issues/${n}`, repo };
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  url.hostname = host;
  let href = url.toString();
  if (href.endsWith("/") && url.pathname !== "/" && url.search === "") href = href.slice(0, -1);
  return { id: `url:${href}`, kind: "url", title: `${host.replace(/^www\./, "")}${url.pathname === "/" ? "" : decodeURIComponent(url.pathname)}`.slice(0, 300), url: href };
}

/** A Linear item from a bare key. */
function linearKey(key: string): Found {
  return { id: `linear:${key}`, kind: "linear", title: key, url: `https://linear.app/ecard-systems/issue/${key}` };
}

function prRef(repo: string, n: string): Found {
  return { id: `gh-pr:${repo}#${n}`, kind: "gh-pr", title: `${repo}#${n}`, url: `https://github.com/${repo}/pull/${n}`, repo };
}

/** The item a path on disk is: a Test Bench run, a canvas, or a file (images and videos carry media). */
function pathItem(path: string, ctx: ScanContext): Found | null {
  const experiment = EXPERIMENT.exec(path);
  if (experiment !== null && ctx.evaRoot !== null) {
    const dir = join(ctx.evaRoot, "work", "experiments", experiment[1] ?? "");
    if (!ctx.exists(dir)) return null;
    return { id: `experiment:${experiment[1]}`, kind: "experiment", title: experiment[1] ?? "", path: dir };
  }
  if (/\/(?:node_modules|\.git)\//.test(path) || !ctx.exists(path)) return null;
  const canvas = /canvases\/([a-z0-9][\w-]{0,79})\.json$/.exec(path);
  if (canvas !== null) return { id: `canvas:${canvas[1]}`, kind: "canvas", title: canvas[1] ?? "", path };
  const name = basename(path);
  if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) return null;
  const mimeType = IMAGE_EXT[name.slice(name.lastIndexOf(".") + 1).toLowerCase()];
  return { id: `file:${path}`, kind: "file", title: name, path, ...(mimeType === undefined ? {} : { media: { mimeType } }) };
}

function resolvePath(raw: string, ctx: ScanContext): string | null {
  const text = trimTail(raw);
  if (text.startsWith("~/")) return normalize(join(homedir(), text.slice(2)));
  if (isAbsolute(text)) return normalize(text);
  return ctx.evaRoot === null ? null : normalize(join(ctx.evaRoot, text));
}

/** Every artifact one piece of message text mentions. */
export function findInText(text: string, ctx: ScanContext): Found[] {
  const out: Found[] = [];
  let consumed = text;
  for (const match of text.matchAll(DROP)) {
    const caption = match[1]?.trim();
    const id = match[2] ?? "";
    const url = `/drops/${id}/${match[3]}`;
    out.push({ id: `drop:${id}`, kind: "drop", title: caption !== undefined && caption !== "" ? caption : "Drop", url, drop: id, ...(caption ? { caption } : {}) });
    consumed = consumed.replace(match[0], " ");
  }
  for (const match of consumed.matchAll(URL_RE)) {
    const found = classifyUrl(match[0]);
    if (found !== null) out.push(found);
  }
  const prose = consumed.replace(URL_RE, " ");
  for (const match of prose.matchAll(LINEAR_BARE)) out.push(linearKey(match[1] ?? ""));
  for (const match of prose.matchAll(REPO_REF)) {
    const repo = match[1] ?? "";
    if (/\.(?:ts|tsx|js|md|json|py|swift)$/.test(repo)) continue;
    out.push(prRef(repo, match[2] ?? ""));
  }
  if (ctx.repo !== null) for (const match of prose.replace(REPO_REF, " ").matchAll(BARE_REF)) out.push(prRef(ctx.repo, match[1] ?? ""));
  for (const match of prose.matchAll(BRANCH)) {
    const name = trimTail(match[1] ?? "");
    out.push({ id: `branch:${name}`, kind: "branch", title: name });
  }
  for (const regex of [ABS_PATH, EVA_PATH]) {
    for (const match of prose.matchAll(regex)) {
      const path = resolvePath(match[1] ?? "", ctx);
      const found = path === null ? null : pathItem(path, ctx);
      if (found !== null) out.push(found);
    }
  }
  for (const match of prose.matchAll(CANVAS)) {
    if (out.some((found) => found.id === `canvas:${match[1]}`)) continue;
    out.push({ id: `canvas:${match[1]}`, kind: "canvas", title: match[1] ?? "" });
  }
  return out;
}

/** Tools that only look at things; their arguments are not artifacts. */
const READ_TOOLS: Readonly<Record<string, true>> = { read: true, grep: true, glob: true, find: true, ls: true, web_search: true };

/**
 * What a tool call contributes: subagents it starts, pages and links it opens in the panel, and the
 * Test Bench runs and canvases it works on. Plain reads count for nothing.
 */
function findInToolCall(name: string, args: Record<string, unknown>, ctx: ScanContext): Found[] {
  if (name === "task") {
    const tasks = Array.isArray(args["tasks"]) ? args["tasks"] : [];
    return tasks.flatMap((task: unknown) => {
      const agent = typeof task === "object" && task !== null ? (task as Record<string, unknown>)["name"] : undefined;
      return typeof agent === "string" && /^[A-Za-z][\w]{0,63}$/.test(agent) ? [subagentItem(agent, ctx)] : [];
    });
  }
  if (READ_TOOLS[name] === true) return [];
  const out: Found[] = [];
  const command = name === "bash" && typeof args["command"] === "string" ? args["command"] : "";
  if (command.includes("relay-ctl")) {
    for (const match of command.matchAll(/browser\.open\s+'(\{[^']*\})'/g)) {
      const url = jsonField(match[1] ?? "", "url");
      const found = url === null ? null : classifyUrl(url, true);
      if (found !== null) out.push(found);
    }
    for (const match of command.matchAll(/testbench\.open\s+'(\{[^']*\})'/g)) {
      const experiment = jsonField(match[1] ?? "", "experiment");
      const found = experiment === null || ctx.evaRoot === null ? null : pathItem(join(ctx.evaRoot, "work", "experiments", basename(experiment)), ctx);
      if (found !== null) out.push(found);
    }
    for (const match of command.matchAll(CANVAS_PAGE)) out.push({ id: `canvas:${match[1]}`, kind: "canvas", title: match[1] ?? "" });
  }
  const text = JSON.stringify(args);
  if (ctx.evaRoot !== null) {
    for (const match of text.matchAll(EXPERIMENTS)) {
      const found = pathItem(join(ctx.evaRoot, "work", "experiments", match[1] ?? ""), ctx);
      if (found !== null) out.push(found);
    }
  }
  for (const match of text.matchAll(CANVAS)) out.push({ id: `canvas:${match[1]}`, kind: "canvas", title: match[1] ?? "" });
  return out;
}

function jsonField(json: string, field: string): string | null {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null) return null;
    const got = (value as Record<string, unknown>)[field];
    return typeof got === "string" ? got : null;
  } catch {
    return null;
  }
}

/** The subagent `name` this transcript started: its own transcript is `<file minus .jsonl>/<name>.jsonl`. */
export function subagentItem(name: string, ctx: ScanContext): Found {
  const path = join(ctx.file.replace(/\.jsonl$/, ""), `${name}.jsonl`);
  return { id: `subagent:${path}`, kind: "subagent", title: name, path };
}

const TASK_RESULT = /<task-result id="([\w.]+)"[^>]*status="(\w+)"/g;
const SPAWNED = /`([A-Za-z][\w]{0,63})` \(job /g;

function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: unknown) => {
    if (typeof part !== "object" || part === null) return [];
    const record = part as Record<string, unknown>;
    return record["type"] === "text" && typeof record["text"] === "string" ? [record["text"]] : [];
  });
}

function imageParts(content: unknown): { data: string; mimeType: string }[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: unknown) => {
    if (typeof part !== "object" || part === null) return [];
    const record = part as Record<string, unknown>;
    return record["type"] === "image" && typeof record["data"] === "string" && typeof record["mimeType"] === "string"
      ? [{ data: record["data"], mimeType: record["mimeType"] }]
      : [];
  });
}

/** A persona prime opens a context with "You are <Name>, Isaac's ...". */
const PRIME = /^\s*You are [A-Z][\w-]*,/;

/**
 * Scans complete lines of a transcript. `ctx.fresh` is true when `raw` starts at the top of the
 * file; the returned `fresh` says whether the first user turn is still ahead for the next chunk.
 */
export function scanTranscript(raw: string, ctx: ScanContext): ScanResult & { readonly fresh: boolean } {
  const messages: ScannedMessage[] = [];
  const ended: SubagentEnded[] = [];
  let cwd: string | null = null;
  let fresh = ctx.fresh;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = typeof entry["timestamp"] === "string" ? Date.parse(entry["timestamp"]) : Number.NaN;
    if (entry["type"] === "session" && typeof entry["cwd"] === "string") cwd = entry["cwd"];
    if (entry["type"] === "custom_message" && entry["customType"] === "async-result" && typeof entry["content"] === "string") {
      for (const match of entry["content"].matchAll(TASK_RESULT)) ended.push({ name: match[1] ?? "", failed: match[2] !== "completed", at: Number.isFinite(at) ? at : 0 });
      continue;
    }
    if (entry["type"] !== "message" || typeof entry["message"] !== "object" || entry["message"] === null) continue;
    const message = entry["message"] as Record<string, unknown>;
    const role = message["role"];
    const stamp = typeof message["timestamp"] === "number" ? message["timestamp"] : at;
    if (!Number.isFinite(stamp)) continue;
    if (role === "toolResult") {
      if (message["toolName"] !== "task") continue;
      const text = textParts(message["content"]).join("\n");
      // Auto-named agents only show up in the spawn notice; synchronous ones finish right here.
      const spawned = [...text.matchAll(SPAWNED)].map((match) => subagentItem(match[1] ?? "", ctx));
      if (spawned.length > 0) messages.push({ key: `assistant@${Math.trunc(stamp)}`, role: "assistant", at: stamp, found: spawned });
      for (const match of text.matchAll(TASK_RESULT)) ended.push({ name: match[1] ?? "", failed: match[2] !== "completed", at: stamp });
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const found: Found[] = [];
    const texts = textParts(message["content"]);
    if (role === "user") {
      const first = fresh;
      fresh = false;
      if (first && texts.some((text) => PRIME.test(text))) continue;
      const caption = texts.join(" ").replace(/\s+/g, " ").trim().slice(0, 120);
      for (const image of imageParts(message["content"])) {
        const sha = createHash("sha256").update(image.data).digest("hex").slice(0, 32);
        found.push({
          id: `image:${sha}`,
          kind: "image",
          title: "Pasted image",
          media: { mimeType: image.mimeType },
          image: { sha, data: image.data, mimeType: image.mimeType },
          ...(caption === "" ? {} : { caption }),
        });
      }
    }
    for (const text of texts) found.push(...findInText(text, ctx));
    if (role === "assistant" && Array.isArray(message["content"])) {
      for (const part of message["content"] as unknown[]) {
        if (typeof part !== "object" || part === null) continue;
        const call = part as Record<string, unknown>;
        if (call["type"] !== "toolCall" || typeof call["name"] !== "string" || typeof call["arguments"] !== "object" || call["arguments"] === null) continue;
        found.push(...findInToolCall(call["name"], call["arguments"] as Record<string, unknown>, ctx));
      }
    }
    const unique = new Map<string, Found>();
    for (const item of found) if (!unique.has(item.id)) unique.set(item.id, item);
    if (unique.size > 0) messages.push({ key: `${role}@${Math.trunc(stamp)}`, role, at: stamp, found: [...unique.values()] });
  }
  return { messages, ended, cwd, fresh };
}
