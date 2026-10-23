import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  handleMediaRequest,
  MediaError,
  parseRange,
  resolveMedia,
  type MediaDeps,
} from './widget-media'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const hits: string[] = []
let server: http.Server
let port = 0
let root = ''
let deps: MediaDeps

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url === '/a.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(PNG)
    } else if (req.url === '/drops/d1/t1') {
      res.writeHead(200, { 'Content-Type': 'audio/wav' })
      res.end(Buffer.from('RIFFxxxxWAVE'))
    } else if (req.url === '/big.bin') {
      res.writeHead(200)
      res.end(Buffer.alloc(64))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterAll(() => {
  server.close()
})

beforeEach(() => {
  hits.length = 0
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-widget-media-'))
  deps = { cacheDir: path.join(root, 'cache'), servePort: () => port, home: root }
})

const request = (src: string, headers: Record<string, string> = {}) =>
  handleMediaRequest(
    new Request(`relay-media://media/?src=${encodeURIComponent(src)}`, { headers }),
    deps,
  )

describe('resolveMedia', () => {
  it('downloads an http(s) URL once into the cache', async () => {
    const url = `http://127.0.0.1:${port}/a.png`
    const first = await resolveMedia(url, deps)
    const second = await resolveMedia(url, deps)
    expect(first).toBe(second)
    expect(path.dirname(first)).toBe(deps.cacheDir)
    expect(path.basename(first)).toMatch(/^[a-f0-9]{64}\.png$/)
    expect(fs.readFileSync(first)).toEqual(PNG)
    expect(hits).toEqual(['/a.png'])
  })

  it('shares one fetch between concurrent requests', async () => {
    const url = `http://127.0.0.1:${port}/a.png`
    const [a, b] = await Promise.all([resolveMedia(url, deps), resolveMedia(url, deps)])
    expect(a).toBe(b)
    expect(hits).toEqual(['/a.png'])
  })

  it('fetches a drop from the local Relay host and names it by its content type', async () => {
    const file = await resolveMedia('/drops/d1/t1', deps)
    expect(hits).toEqual(['/drops/d1/t1'])
    expect(file.endsWith('.wav')).toBe(true)
  })

  it("fails a drop when Relay isn't running", async () => {
    await expect(
      resolveMedia('/drops/d1/t1', { ...deps, servePort: () => null }),
    ).rejects.toMatchObject({
      status: 503,
    })
  })

  it('fails and keeps nothing for a missing or oversized download', async () => {
    await expect(resolveMedia(`http://127.0.0.1:${port}/nope.png`, deps)).rejects.toMatchObject({
      status: 502,
    })
    await expect(
      resolveMedia(`http://127.0.0.1:${port}/big.bin`, { ...deps, maxBytes: 16 }),
    ).rejects.toMatchObject({ status: 413 })
    expect(fs.readdirSync(deps.cacheDir)).toEqual([])
  })

  it('serves local media files by extension only', async () => {
    fs.writeFileSync(path.join(root, 'me.png'), PNG)
    fs.writeFileSync(path.join(root, 'cup.glb'), 'glTF')
    fs.writeFileSync(path.join(root, 'notes.txt'), 'secret')
    expect(await resolveMedia('~/me.png', deps)).toBe(path.join(root, 'me.png'))
    expect(await resolveMedia(path.join(root, 'cup.glb'), deps)).toBe(path.join(root, 'cup.glb'))
    await expect(resolveMedia(path.join(root, 'notes.txt'), deps)).rejects.toMatchObject({
      status: 403,
    })
    await expect(resolveMedia('~/gone.png', deps)).rejects.toMatchObject({ status: 404 })
    await expect(resolveMedia('me.png', deps)).rejects.toBeInstanceOf(MediaError)
    expect(hits).toEqual([])
  })
})

describe('parseRange', () => {
  it('reads open, closed and suffix ranges and rejects unsatisfiable ones', () => {
    expect(parseRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=2-4', 10)).toEqual({ start: 2, end: 4 })
    expect(parseRange('bytes=5-99', 10)).toEqual({ start: 5, end: 9 })
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(parseRange('bytes=10-', 10)).toBeNull()
    expect(parseRange('bytes=4-2', 10)).toBeNull()
    expect(parseRange('bytes=-', 10)).toBeNull()
    expect(parseRange('items=0-1', 10)).toBeNull()
  })
})

describe('handleMediaRequest', () => {
  it('answers with the content type and the whole file', async () => {
    fs.writeFileSync(path.join(root, 'clip.mp4'), Buffer.from('0123456789'))
    const res = await request('~/clip.mp4')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe('10')
    expect(await res.text()).toBe('0123456789')
  })

  it('answers a Range request with 206 and the slice', async () => {
    fs.writeFileSync(path.join(root, 'clip.mp4'), Buffer.from('0123456789'))
    const res = await request('~/clip.mp4', { Range: 'bytes=2-5' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(res.headers.get('content-length')).toBe('4')
    expect(await res.text()).toBe('2345')
    const bad = await request('~/clip.mp4', { Range: 'bytes=20-' })
    expect(bad.status).toBe(416)
    expect(bad.headers.get('content-range')).toBe('bytes */10')
  })

  it('reports a failed source with its status', async () => {
    expect((await request('~/missing.png')).status).toBe(404)
    expect((await request('~/notes.txt')).status).toBe(403)
    expect((await handleMediaRequest(new Request('relay-media://media/'), deps)).status).toBe(400)
  })
})
