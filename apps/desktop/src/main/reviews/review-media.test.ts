import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveMedia } from '../chat/widget-media'
import { isGithubUpload, isLinearUpload, localizeImages, reviewsMediaFile } from './review-media'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

describe('review media', () => {
  // The live config dir has spaces ("Application Support/Relay Dev"); a markdown link to a path
  // in it does not parse, so the markdown must only ever carry the served path.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Application Support '))
  const dir = path.join(root, 'Relay Dev', 'reviews-media')

  afterEach(() => vi.unstubAllGlobals())

  it('downloads matched images with auth and points markdown at /reviews/media, never a file path', async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).authorization })
      return new Response(PNG, { headers: { 'content-type': 'image/png' } })
    })
    const gh = 'https://github.com/user-attachments/assets/0e9e049e'
    const md = [
      `<img width="2900" alt="pair [1440]" src="${gh}" />`,
      `![CleanShot 2026-09-30 at 16.09.53.png](https://uploads.linear.app/a/b?signature=x)`,
      '![public](https://example.com/a.png)',
    ].join('\n\n')
    const out = await localizeImages(md, dir, [
      { match: isGithubUpload, headers: async () => ({ authorization: 'token T' }) },
      { match: isLinearUpload, headers: async () => ({ authorization: 'lin' }) },
    ])
    const lines = out.split('\n\n')
    expect(lines[0]).toMatch(/^!\[pair 1440\]\(\/reviews\/media\/[0-9a-f]{40}\.png\)$/)
    expect(lines[1]).toMatch(
      /^!\[CleanShot 2026-09-30 at 16\.09\.53\.png\]\(\/reviews\/media\/[0-9a-f]{40}\.png\)$/,
    )
    expect(lines[2]).toBe('![public](https://example.com/a.png)')
    expect(out).not.toContain(root)
    expect(seen).toEqual([
      { url: gh, auth: 'token T' },
      { url: 'https://uploads.linear.app/a/b?signature=x', auth: 'lin' },
    ])

    // The relay-media scheme serves the served path from a dir with spaces.
    const served = /\((\/reviews\/media\/[^)]+)\)/.exec(lines[0]!)![1]!
    const file = await resolveMedia(served, {
      cacheDir: path.join(root, 'cache'),
      servePort: () => null,
      home: os.homedir(),
      reviewsDir: dir,
    })
    expect(fs.readFileSync(file)).toEqual(Buffer.from(PNG))

    // A second render reuses the file.
    expect(
      await localizeImages(md, dir, [{ match: isGithubUpload, headers: async () => ({}) }]),
    ).toBe(out.replace(/!\[CleanShot[^\n]+/, md.split('\n\n')[1]!))
    expect(seen).toHaveLength(2)
  })

  it('keeps the URL when a download fails, and serves only names it made', async () => {
    vi.stubGlobal('fetch', async () => new Response('no', { status: 404 }))
    const md = '<img src="https://github.com/user-attachments/assets/gone">'
    expect(
      await localizeImages(md, dir, [{ match: isGithubUpload, headers: async () => ({}) }]),
    ).toBe('![](https://github.com/user-attachments/assets/gone)')
    expect(reviewsMediaFile(dir, '/reviews/media/../../secrets.png')).toBeNull()
    expect(reviewsMediaFile(dir, `/reviews/media/${'a'.repeat(40)}.png`)).toBe(
      path.join(dir, `${'a'.repeat(40)}.png`),
    )
  })
})
