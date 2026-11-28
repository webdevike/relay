import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LinearTicket } from '@evaos/contract'
import type { MainContext } from '../context'
import { registerLinearInbox } from './linear-inbox'
import { UNAVAILABLE_MEDIA } from './review-media'

const handlers = new Map<string, (args: unknown) => Promise<unknown>>()
vi.mock('../ipc/handle', () => ({
  handle: (_ctx: unknown, channel: string, fn: (args: unknown) => Promise<unknown>) =>
    handlers.set(channel, fn),
}))
vi.mock('../linear/linear-ipc', () => ({ apiKey: async () => 'lin_key' }))

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const GRAPHQL = 'https://api.linear.app/graphql'
const DESCRIBED = 'https://uploads.linear.app/ws/desc/shot.png?signature=DESCSECRET'
const COMMENTED = 'https://uploads.linear.app/ws/comment/shot.png?signature=COMMENTSECRET'
const me = { id: 'u1', name: 'Isaac', displayName: 'ike' }

/** One ticket whose description and comment carry Linear's private uploads, as GraphQL answers it. */
const ticket = {
  data: {
    viewer: me,
    issue: {
      id: 'i1',
      identifier: 'ENG-7',
      title: 'Login',
      url: 'https://linear.app/ws/issue/ENG-7',
      description: `Broken:\n\n![desc shot](${DESCRIBED})`,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-02T00:00:00Z',
      priorityLabel: 'High',
      creator: me,
      state: { name: 'Todo', type: 'unstarted', color: '#fff' },
      assignee: null,
      team: { name: 'Eng' },
      labels: { nodes: [] },
      project: null,
      parent: null,
      children: { nodes: [] },
      attachments: { nodes: [] },
      comments: {
        nodes: [
          {
            id: 'c1',
            body: `<img width="320" alt="comment shot" src="${COMMENTED}">`,
            createdAt: '2026-11-01T01:00:00Z',
            url: 'https://linear.app/ws/issue/ENG-7#comment-c1',
            user: me,
            parent: null,
          },
        ],
      },
    },
  },
}

/** `reviews.linearTicket` with GraphQL answering `ticket` and Linear's uploads answering `upload`. */
async function readTicket(
  upload: () => Response,
): Promise<{ t: LinearTicket; seen: Array<{ url: string; auth: string | undefined }> }> {
  const seen: Array<{ url: string; auth: string | undefined }> = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url === GRAPHQL) return Response.json(ticket)
    seen.push({ url, auth: (init.headers as Record<string, string>).authorization })
    return upload()
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linear media '))
  const ctx = { config: { dir }, env: { evaRoot: dir, configDir: dir } } as unknown as MainContext
  registerLinearInbox(ctx, { reads: true, writes: false })
  const t = (await handlers.get('reviews.linearTicket')!({ key: 'ENG-7' })) as LinearTicket
  return { t, seen }
}

describe('Linear ticket media', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    handlers.clear()
  })

  it('downloads description and comment uploads with the key, sent only to uploads.linear.app', async () => {
    const { t, seen } = await readTicket(
      () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
    )
    expect(t.description).toMatch(
      /^Broken:\n\n!\[desc shot\]\(\/reviews\/media\/[0-9a-f]{40}\.png\)$/,
    )
    expect(t.comments[0]?.body).toMatch(
      /^!\[comment shot\]\(\/reviews\/media\/[0-9a-f]{40}\.png "w=320"\)$/,
    )
    expect(seen.sort((a, b) => a.url.localeCompare(b.url))).toEqual([
      { url: COMMENTED, auth: 'lin_key' },
      { url: DESCRIBED, auth: 'lin_key' },
    ])
    expect(JSON.stringify(t)).not.toContain('uploads.linear.app')
  })

  it('shows the unavailable placeholder when an upload refuses the key, never its signed URL', async () => {
    const { t } = await readTicket(() => new Response('no', { status: 401 }))
    expect(t.description).toBe(`Broken:\n\n![desc shot](${UNAVAILABLE_MEDIA})`)
    expect(t.comments[0]?.body).toBe(`![comment shot](${UNAVAILABLE_MEDIA} "w=320")`)
    const out = JSON.stringify(t)
    for (const secret of ['uploads.linear.app', 'SECRET', 'signature='])
      expect(out).not.toContain(secret)
  })
})
