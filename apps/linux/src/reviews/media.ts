// Images in Reviews markdown, served from the host (port of evaos-electron's
// main/reviews/review-media.ts and slack-media.ts). GitHub's uploads (`github.com/user-attachments`,
// `private-user-images`) open only with gh's login, Linear's with the key, and GitHub writes most of
// them as HTML `<img>` tags: each is downloaded once into `ReviewMedia.dir` and the markdown points at
// the host path `/reviews/media/<file>/<token>`, which the phone prefixes with the host URL. Slack's
// files come through the Slack desktop app on this Mac (its debugging port, 127.0.0.1:9333): one
// read-only script in its app.slack.com page asks `files.info` and fetches the file with the page's
// session. Nothing is typed, clicked, navigated or written there.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Fetch, ReviewMedia } from "./linear";

const EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** `![alt](url)`, `![alt](<url>)`, `![alt](url "title")` and `<img ... src="url" ...>`. */
const IMAGE = /!\[([^\]\n]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"([^"]*)")?\s*\)|<img\b[^>]*>/gi;

/** An HTML attribute's value, quoted or not. */
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`[\\s"'/]${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(
    tag,
  );
  return m?.[1] ?? m?.[2] ?? m?.[3];
}

const cleanAlt = (alt: string): string =>
  alt
    .replace(/[[\]\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** An `<img>`'s pixel width: its `width` attribute, else a `width: Npx` in its style. */
function htmlWidth(tag: string): number | undefined {
  const w =
    /^(\d+)(?:px)?\/?$/i.exec(attr(tag, "width") ?? "")?.[1] ??
    /(?:^|;)\s*width\s*:\s*(\d+)(?:\.\d+)?px/i.exec(attr(tag, "style") ?? "")?.[1];
  return w === undefined || Number(w) === 0 ? undefined : Number(w);
}

interface Image {
  alt: string;
  url: string;
  /** The markdown title: an `<img>`'s width as `w=N` (the renderer's bounded width), else its title. */
  title: string | undefined;
}

/** One `IMAGE` match as an image; undefined for an `<img>` without a `src`. */
function image(
  whole: string,
  alt: string | undefined,
  url: string | undefined,
  title: string | undefined,
): Image | undefined {
  if (!whole.startsWith("<")) return url === undefined ? undefined : { alt: alt ?? "", url, title };
  const src = attr(whole, "src");
  if (src === undefined) return undefined;
  const width = htmlWidth(whole);
  return {
    alt: attr(whole, "alt") ?? "",
    url: src,
    title: width === undefined ? attr(whole, "title") : `w=${String(width)}`,
  };
}

function markdownImage(i: Image, url: string): string {
  const title = (i.title ?? "").replace(/"/g, "'").replace(/\s+/g, " ").trim();
  return `![${cleanAlt(i.alt)}](${url}${title === "" ? "" : ` "${title}"`})`;
}

export interface MediaSource {
  /** Whether an image at this URL is downloaded (else it stays as it is). */
  match: (url: string) => boolean;
  /** Request headers for one download (auth), sent only to this URL's own origin. */
  headers: () => Promise<Record<string, string>>;
}

/** `url` when it is plain HTTPS on the default port without credentials; null otherwise. */
function https(url: string): URL | null {
  const u = URL.canParse(url) ? new URL(url) : null;
  return u?.protocol === "https:" && u.port === "" && u.username === "" && u.password === ""
    ? u
    : null;
}

export const isGithubUpload = (url: string): boolean => {
  const u = https(url);
  return (
    (u?.hostname === "github.com" && u.pathname.startsWith("/user-attachments/assets/")) ||
    u?.hostname === "private-user-images.githubusercontent.com"
  );
};
export const isLinearUpload = (url: string): boolean =>
  https(url)?.hostname === "uploads.linear.app";

/** A URL as origin + path: a signed URL's query (GitHub's JWT) never goes into an error or a log. */
export function redactUrl(url: string): string {
  return URL.canParse(url) ? ((u) => `${u.origin}${u.pathname}`)(new URL(url)) : "(a bad URL)";
}

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

async function request(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  fetchFn: Fetch,
): Promise<Response> {
  try {
    return await fetchFn(url, { headers, redirect: "manual", signal });
  } catch {
    throw new Error(`Couldn't fetch ${redactUrl(url)}`);
  }
}

/** Where a redirect from `url` leads; only another private upload over HTTPS, at most `MAX_REDIRECTS` times. */
function nextHop(res: Response, url: string, hop: number): string {
  if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects at ${redactUrl(url)}`);
  const location = res.headers.get("location") ?? "";
  const next = URL.canParse(location, url) ? new URL(location, url).href : "";
  if (!isGithubUpload(next) && !isLinearUpload(next))
    throw new Error(`${redactUrl(url)} redirected to a host that is not allowed`);
  return next;
}

/** The body, refused past `MAX_BYTES` (announced or streamed). */
async function capped(res: Response, url: string): Promise<Buffer> {
  const tooBig = (): Error => new Error(`${redactUrl(url)} is over 10 MB`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw tooBig();
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let r = await reader?.read(); r !== undefined && !r.done; r = await reader?.read()) {
    size += r.value.byteLength;
    if (size > MAX_BYTES) {
      await reader?.cancel();
      throw tooBig();
    }
    chunks.push(r.value);
  }
  return Buffer.concat(chunks, size);
}

/**
 * One image: redirects followed by hand, auth only to `url`'s own origin (a GitHub token never goes
 * to another host, a Linear key never to GitHub), at most 10 MB in 20 s. Errors name the URL
 * without its query.
 */
export async function fetchMedia(
  url: string,
  headers: Record<string, string>,
  fetchFn: Fetch,
): Promise<{ ext: string; bytes: Buffer }> {
  const signal = AbortSignal.timeout(20_000);
  const origin = new URL(url).origin;
  let at = url;
  for (let hop = 0; ; hop += 1) {
    const res = await request(at, new URL(at).origin === origin ? headers : {}, signal, fetchFn);
    if (REDIRECT.has(res.status)) {
      at = nextHop(res, at, hop);
      continue;
    }
    if (!res.ok) throw new Error(`${redactUrl(at)} answered ${String(res.status)}`);
    const ext =
      EXT[(res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? ""];
    if (ext === undefined) throw new Error(`${redactUrl(at)} is not an image`);
    return { ext, bytes: await capped(res, at) };
  }
}

/** A file of `media` named `<sha1 of key><ext>`, when it is there. */
function kept(media: ReviewMedia, key: string): string | undefined {
  const sha = createHash("sha1").update(key).digest("hex");
  return existsSync(media.dir)
    ? readdirSync(media.dir).find((f) => f.startsWith(`${sha}.`) && !f.endsWith(".part"))
    : undefined;
}

export interface MediaLimits {
  files: number;
  bytes: number;
}

/** The media dir's bound: past either, the oldest files go (an evicted one downloads again on its next render). */
export const MEDIA_LIMITS: MediaLimits = { files: 2000, bytes: 500 * 1024 * 1024 };
const RESCAN_MS = 5 * 60_000;

/** Per dir: files and bytes at the last full scan plus what was written since. */
const tallies = new Map<string, { files: number; bytes: number; scannedAt: number }>();

/** Deletes the oldest files of `dir` (never `newest`) until it fits `limits`; answers what is left. */
function evictOldest(
  dir: string,
  newest: string,
  limits: MediaLimits,
): { files: number; bytes: number } {
  const files = readdirSync(dir)
    .filter((f) => !f.startsWith("."))
    .flatMap((name) => {
      const s = statSync(join(dir, name), { throwIfNoEntry: false });
      return s?.isFile() === true ? [{ name, size: s.size, mtime: s.mtimeMs }] : [];
    })
    .sort((a, b) => a.mtime - b.mtime);
  const left = { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
  for (const f of files) {
    if (left.files <= limits.files && left.bytes <= limits.bytes) break;
    if (f.name === newest) continue;
    rmSync(join(dir, f.name), { force: true });
    left.files -= 1;
    left.bytes -= f.size;
  }
  return left;
}

/** After `name` (`size` bytes) is written: counts are estimates between full scans (the first write, then at most every 5 minutes or when over `limits`). */
function bound(dir: string, name: string, size: number, limits: MediaLimits): void {
  const now = Date.now();
  const t = tallies.get(dir);
  if (t !== undefined && now - t.scannedAt < RESCAN_MS) {
    t.files += 1;
    t.bytes += size;
    if (t.files <= limits.files && t.bytes <= limits.bytes) return;
  }
  tallies.set(dir, { ...evictOldest(dir, name, limits), scannedAt: now });
}

/** Writes `bytes` as `<sha1 of key><ext>` (0600), keeping the dir in `media.limits`; answers the file name. */
function keep(media: ReviewMedia, key: string, ext: string, bytes: Buffer): string {
  const name = `${createHash("sha1").update(key).digest("hex")}${ext}`;
  mkdirSync(media.dir, { recursive: true, mode: 0o700 });
  const part = join(media.dir, `.${name}.${String(process.pid)}.part`);
  writeFileSync(part, bytes, { mode: 0o600 });
  renameSync(part, join(media.dir, name));
  bound(media.dir, name, bytes.length, media.limits);
  return name;
}

const inflight = new Map<string, Promise<string>>();

/** `url` as a host media path, downloaded once with `source`'s headers; the URL itself on failure. */
function download(
  url: string,
  media: ReviewMedia,
  source: MediaSource,
  fetchFn: Fetch,
): Promise<string> {
  const have = kept(media, url);
  if (have !== undefined) return Promise.resolve(media.path(have));
  const running = inflight.get(url);
  if (running !== undefined) return running;
  const job = (async (): Promise<string> => {
    try {
      const { ext, bytes } = await fetchMedia(url, await source.headers(), fetchFn);
      return media.path(keep(media, url, ext, bytes));
    } catch {
      return url;
    }
  })().finally(() => inflight.delete(url));
  inflight.set(url, job);
  return job;
}

/**
 * Every image in `md` as markdown: `<img>` tags become `![alt](src "w=N")` (their width kept as the
 * title), titles stay, and images a source matches point at the host's copy. An image that fails to
 * download keeps its URL.
 */
export async function localizeImages(
  md: string,
  media: ReviewMedia,
  sources: readonly MediaSource[],
  fetchFn: Fetch,
): Promise<string> {
  const urls = new Set<string>();
  for (const m of md.matchAll(IMAGE)) {
    const url = image(m[0], m[1], m[2], m[3])?.url;
    if (url !== undefined) urls.add(url);
  }
  const local = new Map(
    await Promise.all(
      [...urls].map(async (url) => {
        const source = sources.find((s) => s.match(url));
        return [
          url,
          source === undefined ? url : await download(url, media, source, fetchFn),
        ] as const;
      }),
    ),
  );
  return md.replace(
    IMAGE,
    (
      whole: string,
      alt: string | undefined,
      mdUrl: string | undefined,
      title: string | undefined,
    ) => {
      const i = image(whole, alt, mdUrl, title);
      return i === undefined ? whole : markdownImage(i, local.get(i.url) ?? i.url);
    },
  );
}

export const SLACK_CDP = "http://127.0.0.1:9333";
const MAX_FULL_BYTES = 12 * 1024 * 1024;

/** The script run in Slack's page: `files.info` with Slack's own session, then the image as base64. */
export function slackFetchScript(fileId: string, maxBytes = MAX_FULL_BYTES): string {
  return `(async () => {
  try {
    const cfg = JSON.parse(localStorage.getItem('localConfig_v2') || '{}');
    const team = Object.values(cfg.teams || {})[0];
    if (!team) return { error: 'Slack is not signed in' };
    const body = new FormData();
    body.append('token', team.token);
    body.append('file', ${JSON.stringify(fileId)});
    const info = await (await fetch('/api/files.info', { method: 'POST', body, credentials: 'include' })).json();
    if (!info.ok) return { error: 'files.info: ' + info.error };
    const f = info.file;
    if (!/^image\\//.test(f.mimetype || '')) return { error: 'not an image' };
    const url = (f.size || 0) <= ${String(maxBytes)} ? (f.url_private || f.thumb_1024) : (f.thumb_1024 || f.thumb_720 || f.url_private);
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { error: 'download ' + res.status };
    const type = (res.headers.get('content-type') || f.mimetype || '').split(';')[0];
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { type, data: btoa(bin) };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
})()`;
}

const Targets = z.array(
  z.object({ type: z.string(), url: z.string(), webSocketDebuggerUrl: z.string().optional() }),
);
const Answer = z.union([
  z.object({ type: z.string(), data: z.string() }),
  z.object({ error: z.string() }).passthrough(),
]);

/** Evaluates `expression` in Slack's client page; null when Slack is not listening on `cdp`. */
async function evaluate(expression: string, cdp: string): Promise<unknown> {
  let targets: z.infer<typeof Targets>;
  try {
    targets = Targets.parse(
      await (await fetch(`${cdp}/json/list`, { signal: AbortSignal.timeout(2_000) })).json(),
    );
  } catch {
    return null;
  }
  const page = targets.find((t) => t.type === "page" && t.url.includes("app.slack.com/client"));
  if (page?.webSocketDebuggerUrl === undefined) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const timer = setTimeout(() => {
    reject(new Error("Slack did not answer"));
  }, 60_000);
  ws.onerror = () => {
    reject(new Error("Could not reach Slack"));
  };
  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as {
      id?: number;
      result?: { result?: { value?: unknown } };
    };
    if (m.id === 1) resolve(m.result?.result?.value ?? { error: "no answer" });
  };
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    ws.close();
  }
}

const slackInflight = new Map<string, Promise<string | null>>();

/** Slack file `fileId` as a host media path, fetched once through Slack's page; null when it can't be. */
export function slackImage(
  fileId: string,
  media: ReviewMedia,
  cdp = SLACK_CDP,
): Promise<string | null> {
  const key = `slack:${fileId}`;
  const have = kept(media, key);
  if (have !== undefined) return Promise.resolve(media.path(have));
  const running = slackInflight.get(key);
  if (running !== undefined) return running;
  const job = (async (): Promise<string | null> => {
    try {
      const a = Answer.safeParse(await evaluate(slackFetchScript(fileId), cdp));
      if (!a.success || "error" in a.data) return null;
      const ext = EXT[a.data.type.toLowerCase()];
      if (ext === undefined) return null;
      return media.path(keep(media, key, ext, Buffer.from(a.data.data, "base64")));
    } catch {
      return null;
    }
  })().finally(() => slackInflight.delete(key));
  slackInflight.set(key, job);
  return job;
}
