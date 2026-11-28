import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import signedImages from '@relay/protocol/fixtures/signed-images.json'
import { resolveMedia } from '../chat/widget-media'
import {
  fetchMedia,
  isGithubUpload,
  isLinearUpload,
  localizeImages,
  redactUrl,
  reviewsMediaFile,
  UNAVAILABLE_MEDIA,
} from './review-media'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

/** A failed private image: the placeholder with its alt and title, its URL nowhere in the output. */
function expectUnavailable(out: string, expected: string, ...secrets: string[]): void {
  expect(out).toBe(expected)
  for (const secret of secrets) expect(JSON.stringify(out)).not.toContain(secret)
}

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
    expect(lines[0]).toMatch(/^!\[pair 1440\]\(\/reviews\/media\/[0-9a-f]{40}\.png "w=2900"\)$/)
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
    const served = /\((\/reviews\/media\/[^)\s]+)/.exec(lines[0]!)![1]!
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

  it('points a failed download at the unavailable placeholder, and serves only names it made', async () => {
    vi.stubGlobal('fetch', async () => new Response('no', { status: 404 }))
    const md = '<img src="https://github.com/user-attachments/assets/gone">'
    expectUnavailable(
      await localizeImages(md, dir, [{ match: isGithubUpload, headers: async () => ({}) }]),
      `![](${UNAVAILABLE_MEDIA})`,
      'assets/gone',
    )
    expect(reviewsMediaFile(dir, '/reviews/media/../../secrets.png')).toBeNull()
    expect(reviewsMediaFile(dir, `/reviews/media/${'a'.repeat(40)}.png`)).toBe(
      path.join(dir, `${'a'.repeat(40)}.png`),
    )
  })

  it('keeps titles, turns an <img> width into w=N (w=N <title> with a title too), both syntaxes', async () => {
    const md = [
      // Quoted: under the renderer's grammar (micromark + GFM) an unquoted URL value is text with an autolink.
      '<img width=400 src="https://example.com/a.png" alt=wide>',
      '<img style="max-width: 90%; width: 320px" src="https://example.com/b.png">',
      `<img title='A "quoted" one' src='https://example.com/c.png'>`,
      '![sized](https://example.com/d.png "w=250")',
      '![titled](<https://example.com/e.png> "The shot")',
      '<img width="50%" src="https://example.com/f.png">',
      '<img width="320" title="Login" src="https://example.com/g.png">',
    ].join('\n\n')
    expect((await localizeImages(md, dir, [])).split('\n\n')).toEqual([
      '![wide](https://example.com/a.png "w=400")',
      '![](https://example.com/b.png "w=320")',
      `![](https://example.com/c.png "A 'quoted' one")`,
      '![sized](https://example.com/d.png "w=250")',
      '![titled](https://example.com/e.png "The shot")',
      '![](https://example.com/f.png)',
      '![](https://example.com/g.png "w=320 Login")',
    ])
  })

  it("keeps a host image's title when it is copied from the Relay host", async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
    )
    const prefix = 'http://h:1/reviews/media/'
    const out = await localizeImages(`![shot](${prefix}${'b'.repeat(40)}.png/tok "w=400")`, dir, [
      { match: (u) => u.startsWith(prefix), headers: async () => ({}) },
    ])
    expect(out).toMatch(/^!\[shot\]\(\/reviews\/media\/[0-9a-f]{40}\.png "w=400"\)$/)
  })

  it('follows a redirect only to allowlisted hosts, with auth only for the first origin', async () => {
    const seen: Array<{ url: string; auth: string | undefined; redirect: string | undefined }> = []
    const signed = 'https://private-user-images.githubusercontent.com/1/a.png?jwt=SECRET'
    const routes: Record<string, string> = {
      'https://github.com/user-attachments/assets/ok': signed,
      'https://uploads.linear.app/x/to-github': signed,
      'https://github.com/user-attachments/assets/evil': 'https://evil.example/x?jwt=SECRET',
    }
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>
      seen.push({ url, auth: headers.authorization, redirect: init.redirect })
      const location = routes[url]
      return location
        ? new Response(null, { status: 302, headers: { location } })
        : new Response(PNG, { headers: { 'content-type': 'image/png' } })
    })
    expect(
      await fetchMedia('https://github.com/user-attachments/assets/ok', {
        authorization: 'token T',
      }),
    ).toMatchObject({ ext: '.png' })
    expect(seen).toEqual([
      { url: 'https://github.com/user-attachments/assets/ok', auth: 'token T', redirect: 'manual' },
      { url: signed, auth: undefined, redirect: 'manual' },
    ])
    seen.length = 0
    await fetchMedia('https://uploads.linear.app/x/to-github', { authorization: 'lin' })
    expect(seen.map((s) => s.auth)).toEqual(['lin', undefined])

    seen.length = 0
    const evil = 'https://github.com/user-attachments/assets/evil'
    expectUnavailable(
      await localizeImages(`![x](${evil} "Proof")`, dir, [
        { match: isGithubUpload, headers: async () => ({ authorization: 'token T' }) },
      ]),
      `![x](${UNAVAILABLE_MEDIA} "Proof")`,
      evil,
      'SECRET',
    )
    expect(seen.map((s) => s.url)).toEqual([evil])
  })

  it('shows an expired, timed out or failing JWT image as the placeholder, the JWT out of output and errors', async () => {
    const jwt = 'https://private-user-images.githubusercontent.com/9/old.png?jwt=eyJSECRET'
    const auths: Array<string | undefined> = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      auths.push((init.headers as Record<string, string>).authorization)
      return new Response('expired', { status: 403 })
    })
    const md = `<img width="400" alt="proof" src="${jwt}">`
    const sources = [{ match: isGithubUpload, headers: async () => ({ authorization: 'token T' }) }]
    const unavailable = async (): Promise<void> =>
      expectUnavailable(
        await localizeImages(md, dir, sources),
        `![proof](${UNAVAILABLE_MEDIA} "w=400")`,
        'eyJSECRET',
        'jwt=',
        'private-user-images',
      )
    await unavailable()
    expect(auths).toEqual(['token T'])
    for (const failing of [
      async () => new Response('unauthorized', { status: 401 }),
      async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError')
      },
      async () => {
        throw new Error(`boom ${jwt}`)
      },
    ]) {
      vi.stubGlobal('fetch', failing)
      await unavailable()
    }
    vi.stubGlobal('fetch', async () => new Response('expired', { status: 403 }))
    const error = await fetchMedia(jwt, {}).catch((e: unknown) => String(e))
    expect(error).toBe(
      'Error: https://private-user-images.githubusercontent.com/9/old.png answered 403',
    )
    vi.stubGlobal('fetch', async (url: string) => {
      throw new Error(`boom ${url}`)
    })
    expect(await fetchMedia(jwt, {}).catch((e: unknown) => String(e))).not.toContain('SECRET')
    expect(redactUrl(jwt)).toBe('https://private-user-images.githubusercontent.com/9/old.png')
  })

  it('refuses too many redirects and images over 10 MB, a refused image the placeholder', async () => {
    const loop = 'https://github.com/user-attachments/assets/loop'
    const calls = vi.fn(
      async () => new Response(null, { status: 307, headers: { location: loop } }),
    )
    vi.stubGlobal('fetch', calls)
    await expect(fetchMedia(loop, {})).rejects.toThrow('Too many redirects')
    expect(calls).toHaveBeenCalledTimes(4)

    const MB = 1024 * 1024
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(PNG, {
          headers: { 'content-type': 'image/png', 'content-length': String(11 * MB) },
        }),
    )
    await expect(fetchMedia('https://uploads.linear.app/big', {})).rejects.toThrow('over 10 MB')
    let pulled = 0
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: (c) => {
              pulled += 1
              c.enqueue(new Uint8Array(MB))
            },
          }),
          { headers: { 'content-type': 'image/png' } },
        ),
    )
    await expect(fetchMedia('https://uploads.linear.app/endless', {})).rejects.toThrow('over 10 MB')
    expect(pulled).toBeLessThan(13)
    pulled = 0
    const endless = 'https://uploads.linear.app/endless?signature=BIGSECRET'
    expectUnavailable(
      await localizeImages(`![big](${endless} "w=640")`, dir, [
        { match: isLinearUpload, headers: async () => ({ authorization: 'lin' }) },
      ]),
      `![big](${UNAVAILABLE_MEDIA} "w=640")`,
      'BIGSECRET',
      'uploads.linear.app',
    )
    expect(pulled).toBeLessThan(13)
    expect(isGithubUpload('https://github.com.evil.example/user-attachments/assets/x')).toBe(false)
    expect(isLinearUpload('http://uploads.linear.app/x')).toBe(false)
  })

  it('keeps the media dir within its bound, oldest first, and downloads an evicted image again', async () => {
    const fetched = vi.fn(
      async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
    )
    vi.stubGlobal('fetch', fetched)
    const file = (name: string): string =>
      `${createHash('sha1').update(`https://uploads.linear.app/${name}`).digest('hex')}.png`
    const get = (bounded: string, name: string, limits: { files: number; bytes: number }) =>
      localizeImages(
        `![](https://uploads.linear.app/${name})`,
        bounded,
        [{ match: isLinearUpload, headers: async () => ({}) }],
        limits,
      )
    const age = (bounded: string, name: string, seconds: number): void => {
      const t = Date.now() / 1000 - seconds
      fs.utimesSync(path.join(bounded, file(name)), t, t)
    }

    const byCount = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-bound-'))
    const two = { files: 2, bytes: 1e9 }
    const a = await get(byCount, 'a', two)
    age(byCount, 'a', 300)
    await get(byCount, 'b', two)
    age(byCount, 'b', 200)
    await get(byCount, 'c', two)
    expect(fs.readdirSync(byCount).sort()).toEqual([file('b'), file('c')].sort())
    // A missing file is not cached: the next render downloads it again.
    expect(await get(byCount, 'a', two)).toBe(a)
    expect(fetched).toHaveBeenCalledTimes(4)
    expect(fs.existsSync(path.join(byCount, file('a')))).toBe(true)
    expect(fs.existsSync(path.join(byCount, file('b')))).toBe(false)

    const byBytes = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-bound-'))
    const ten = { files: 100, bytes: 10 }
    await get(byBytes, 'x', ten)
    age(byBytes, 'x', 300)
    await get(byBytes, 'y', ten)
    age(byBytes, 'y', 200)
    await get(byBytes, 'z', ten)
    expect(fs.readdirSync(byBytes).sort()).toEqual([file('y'), file('z')].sort())
  })
})

describe('signed GitHub images in every form the clients render', () => {
  const github = [{ match: isGithubUpload, headers: async () => ({ authorization: 'token T' }) }]
  const fresh = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'relay signed '))
  afterEach(() => vi.unstubAllGlobals())

  it.each(Object.entries(signedImages.forms))(
    'serves %s from /reviews/media and keeps no signature',
    async (_, md) => {
      vi.stubGlobal(
        'fetch',
        async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
      )
      const out = await localizeImages(md, fresh(), github)
      expect(out).toMatch(/\/reviews\/media\/[0-9a-f]{40}\.png/)
      for (const secret of signedImages.secrets) expect(JSON.stringify(out)).not.toContain(secret)
    },
  )

  it.each(Object.entries(signedImages.forms))(
    'points a failed %s at the placeholder and keeps no signature',
    async (_, md) => {
      vi.stubGlobal('fetch', async () => new Response('no', { status: 404 }))
      const out = await localizeImages(md, fresh(), github)
      expect(out).toContain(UNAVAILABLE_MEDIA)
      for (const secret of signedImages.secrets) expect(JSON.stringify(out)).not.toContain(secret)
    },
  )
})
