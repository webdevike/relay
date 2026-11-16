// `GET /share/<token>`: a read-only page of one shared board, or of one tab of it, for anyone
// holding the token (published on the tailnet by `tailscale serve --set-path=/share`). The page
// gets only what was shared: a shared tab brings that tab's tiles and its title, never its
// siblings, the board list or any host route. Live tiles render with data from this load, so a
// reload refreshes them. The page itself runs sandboxed (CSP `sandbox`, an opaque origin) with no
// network but https and data: images, and sends no Referer, so the token never leaves in a link.

import { gzipSync } from "node:zlib";
import type { SharedBoard, SharedTile } from "@relay/protocol";
import {
  WIDGET_RUNTIME_CSS,
  WIDGET_RUNTIME_JS,
} from "../../../../packages/widget-runtime/generated/bundle";
import { defaultConfig } from "../../../../packages/widget-runtime/src/theme";
import {
  SHARE_DATA_SLOT,
  SHARE_RUNTIME_SLOT,
} from "../../../../packages/canvas-web/src/share/slots";
import { scriptJson } from "../../../../packages/widget-runtime/src/frame";
import type { BoardShares } from "./shares";
import type { FileBoardStore, LiveRender } from "./store";

export const SHARE_PREFIX = "/share/";

/** Inline script and eval (the Mantine runtime compiles tile JSX), https and data: images, nothing else. */
export const SHARE_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: https:",
  "font-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
].join("; ");

export interface SharePageDeps {
  readonly shares: BoardShares | null;
  readonly boards: FileBoardStore | null;
  /** Renders a live tile with data from now; null draws the spec stored at its last write. */
  readonly live: LiveRender | null;
  /** generated/share.html from packages/canvas-web (tests hand in their own). */
  readonly page: () => string;
}

const GONE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not shared</title></head>
<body style="font-family: -apple-system, system-ui, sans-serif; margin: 40px 20px; color: #868e96">This link is not shared anymore.</body></html>`;

function respond(request: Request, status: number, html: string): Response {
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": SHARE_PAGE_CSP,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    vary: "accept-encoding",
  };
  if (!/\bgzip\b/.test(request.headers.get("accept-encoding") ?? ""))
    return new Response(html, { status, headers });
  return new Response(gzipSync(html), {
    status,
    headers: { ...headers, "content-encoding": "gzip" },
  });
}

/** What `token` shares right now, live tiles drawn with fresh data; null when it shares nothing (any more). */
export async function sharedBoard(
  deps: Omit<SharePageDeps, "page">,
  token: string,
): Promise<SharedBoard | null> {
  const share = deps.shares?.resolve(token) ?? null;
  const board = share === null ? null : (deps.boards?.get(share.slug) ?? null);
  if (share === null || board === null) return null;
  const tabs =
    share.tab === undefined
      ? (board.tabs ?? [{ id: "board", title: board.title, widgets: board.widgets }])
      : (board.tabs ?? []).filter((tab) => tab.id === share.tab);
  if (tabs.length === 0) return null;
  const live = deps.live;
  const drawn = await Promise.all(
    tabs.map(async (tab) => ({
      id: tab.id,
      title: tab.title,
      widgets: await Promise.all(
        tab.widgets.map(async ({ openui, ...tile }): Promise<SharedTile> => {
          if (openui === undefined || live === null) return tile;
          try {
            return { ...tile, spec: await live(openui) };
          } catch {
            return tile;
          }
        }),
      ),
    })),
  );
  return {
    title: board.title,
    tab: share.tab === undefined ? null : (drawn[0]?.title ?? null),
    updatedAt: board.updatedAt,
    renderedAt: new Date().toISOString(),
    tabs: drawn,
    mantineConfig: drawn.some((tab) => tab.widgets.some((tile) => tile.mantine !== undefined))
      ? defaultConfig
      : null,
  };
}

/** Every `/share/...` request. */
export async function handleShareRequest(
  deps: SharePageDeps,
  request: Request,
  path: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("method not allowed", { status: 405 });
  const [token = "", ...rest] = path.slice(SHARE_PREFIX.length).split("/");
  if (rest.length > 1 || (rest.length === 1 && rest[0] !== "")) return respond(request, 404, GONE);
  const shared = await sharedBoard(deps, token);
  if (shared === null) return respond(request, 404, GONE);
  const runtime =
    shared.mantineConfig === null
      ? ""
      : `<style>${WIDGET_RUNTIME_CSS}</style>\n<script>${WIDGET_RUNTIME_JS}</script>`;
  const html = deps
    .page()
    .replace(SHARE_RUNTIME_SLOT, () => runtime)
    .replace(SHARE_DATA_SLOT, () => scriptJson(shared));
  return respond(request, 200, html);
}
