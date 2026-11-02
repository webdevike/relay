// Slack's files in Reviews. The claude.ai connector names a message's files and their ids but cannot
// hand over the bytes, and the app holds no Slack token. The Slack desktop app on this Mac runs with
// a debugging port (127.0.0.1:9333, references/tools/accounts-and-messaging.md), signed in as
// Isaac: main evaluates one read-only script in its app.slack.com page, which asks Slack's own
// `files.info` with the page's session and fetches the file (credentials included), and answers
// the bytes. Nothing is typed, clicked or navigated; nothing is written to Slack. The file is kept
// in `reviews-media` and served as `/reviews/media/<file>` like GitHub's and Linear's images. When
// Slack is not listening there, the file stays a chip with "Open in Slack".
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { REVIEWS_MEDIA_PREFIX } from './review-media'

export const SLACK_CDP = 'http://127.0.0.1:9333'
/** Larger files come as Slack's 1024 px thumbnail instead. */
const MAX_FULL_BYTES = 12 * 1024 * 1024
const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

/**
 * The script run in Slack's page: `files.info` with the workspace token from Slack's own local
 * config, then the image (or its largest thumbnail) as base64. Answers `{ error }` on any failure.
 */
export function fetchScript(fileId: string, maxBytes = MAX_FULL_BYTES): string {
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
    if (!/^image\\//.test(f.mimetype || '')) return { error: 'not an image', mimetype: f.mimetype };
    const url = (f.size || 0) <= ${maxBytes} ? (f.url_private || f.thumb_1024) : (f.thumb_1024 || f.thumb_720 || f.url_private);
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { error: 'download ' + res.status };
    const type = (res.headers.get('content-type') || f.mimetype || '').split(';')[0];
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { type, data: btoa(bin) };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
})()`
}

const Target = z.array(
  z.object({ type: z.string(), url: z.string(), webSocketDebuggerUrl: z.string().optional() }),
)
const Answer = z.union([
  z.object({ type: z.string(), data: z.string() }),
  z.object({ error: z.string() }).passthrough(),
])

/** Evaluates `expression` in Slack's client page; null when Slack is not listening on its port. */
async function evaluate(expression: string, cdp: string): Promise<unknown | null> {
  let targets: z.infer<typeof Target>
  try {
    const res = await fetch(`${cdp}/json/list`, { signal: AbortSignal.timeout(2_000) })
    targets = Target.parse(await res.json())
  } catch {
    return null
  }
  const page = targets.find((t) => t.type === 'page' && t.url.includes('app.slack.com/client'))
  if (!page?.webSocketDebuggerUrl) return null
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  const timer = setTimeout(() => reject(new Error('Slack did not answer')), 60_000)
  ws.onerror = () => reject(new Error('Could not reach Slack'))
  ws.onopen = () =>
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    )
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as {
      id?: number
      result?: { result?: { value?: unknown } }
    }
    if (m.id === 1) resolve(m.result?.result?.value ?? { error: 'no answer' })
  }
  try {
    return await promise
  } finally {
    clearTimeout(timer)
    ws.close()
  }
}

export type SlackMediaResult = { image: string } | { error: string; offline?: boolean }

const inflight = new Map<string, Promise<SlackMediaResult>>()

/** File `fileId` as `/reviews/media/<file>`, fetched once through Slack's page and kept in `dir`. */
export function slackImage(
  fileId: string,
  dir: string,
  cdp = SLACK_CDP,
): Promise<SlackMediaResult> {
  const hash = createHash('sha1').update(`slack:${fileId}`).digest('hex')
  const have = fs.existsSync(dir)
    ? fs.readdirSync(dir).find((f) => f.startsWith(`${hash}.`))
    : undefined
  if (have) return Promise.resolve({ image: REVIEWS_MEDIA_PREFIX + have })
  const running = inflight.get(hash)
  if (running) return running
  const job = (async (): Promise<SlackMediaResult> => {
    let raw: unknown
    try {
      raw = await evaluate(fetchScript(fileId), cdp)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), offline: true }
    }
    if (raw === null) return { error: "Slack isn't open with its debugging port", offline: true }
    const a = Answer.safeParse(raw)
    if (!a.success) return { error: 'Slack answered in the wrong shape' }
    if ('error' in a.data) return { error: a.data.error }
    const ext = EXT[a.data.type.toLowerCase()]
    if (!ext) return { error: `not an image (${a.data.type})` }
    fs.mkdirSync(dir, { recursive: true })
    const name = `${hash}${ext}`
    const part = path.join(dir, `.${name}.${process.pid}.part`)
    fs.writeFileSync(part, Buffer.from(a.data.data, 'base64'))
    fs.renameSync(part, path.join(dir, name))
    return { image: REVIEWS_MEDIA_PREFIX + name }
  })().finally(() => inflight.delete(hash))
  inflight.set(hash, job)
  return job
}
