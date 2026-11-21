import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyMedia, parseMediaRef, saveMedia, type MediaActionDeps } from './media-actions'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const CLIP = Buffer.from('....ftypisom0123456789abcdef')
const relay = (src: string): string => `relay-media://media/?src=${encodeURIComponent(src)}`

let server: http.Server
let port = 0
let root = ''
let downloads = ''
let deps: MediaActionDeps
let answer: string | null = null
const asked: Array<{ defaultPath: string; title: string }> = []
const images: Buffer[] = []
const texts: string[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/drops/vid1/SECRETTOKEN') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' })
      res.end(CLIP)
    } else if (req.url === '/drops/pic1/SECRETTOKEN') {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(PNG)
    } else if (req.url === '/drops/glb1/SECRETTOKEN') {
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary' })
      res.end(Buffer.from('glTF'))
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-media-save-'))
  downloads = path.join(root, 'Downloads')
  fs.mkdirSync(downloads)
  answer = null
  asked.length = 0
  images.length = 0
  texts.length = 0
  deps = {
    media: { cacheDir: path.join(root, 'cache'), servePort: () => port, home: root },
    downloadsDir: () => downloads,
    chooseSavePath: async (opts) => {
      asked.push(opts)
      return answer
    },
    writeImage: async (bytes) => void images.push(bytes),
    writeText: (text) => void texts.push(text),
  }
})

describe('parseMediaRef', () => {
  it('takes the src out of a relay-media URL and the bytes out of a data: image', () => {
    expect(parseMediaRef(relay('/drops/a/b'))).toEqual({ kind: 'relay', src: '/drops/a/b' })
    const data = parseMediaRef(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(data).toEqual({ kind: 'data', type: 'image/png', bytes: PNG })
  })

  it('refuses anything else', () => {
    for (const ref of [
      'https://example.com/a.png',
      'file:///etc/passwd',
      'relay-media://other/?src=/drops/a/b',
      'relay-media://media/x?src=/drops/a/b',
      'relay-media://media/',
      'data:text/html;base64,PGI+',
    ])
      expect(() => parseMediaRef(ref), ref).toThrow(expect.objectContaining({ code: 'not-media' }))
  })
})

describe('saveMedia', () => {
  it('offers Downloads with the caption and the type the drop is served as', async () => {
    answer = path.join(root, 'picked.mp4')
    const out = await saveMedia(relay('/drops/vid1/SECRETTOKEN'), 'Demo clip', deps)
    expect(asked).toEqual([
      { defaultPath: path.join(downloads, 'demo-clip.mp4'), title: 'Save Video' },
    ])
    expect(out).toEqual({ path: answer })
    expect(fs.readFileSync(answer)).toEqual(CLIP)
  })

  it('names an uncaptioned drop by its id, never its token', async () => {
    await saveMedia(relay('/drops/pic1/SECRETTOKEN'), 'Image 1 of 2', deps)
    expect(asked[0]!.defaultPath).toBe(path.join(downloads, 'pic1.png'))
    expect(asked[0]!.title).toBe('Save Image')
  })

  it('writes nothing when Isaac cancels', async () => {
    expect(await saveMedia(relay('/drops/pic1/SECRETTOKEN'), undefined, deps)).toEqual({
      path: null,
    })
    expect(fs.readdirSync(downloads)).toEqual([])
  })

  it('saves a pasted data: image as its own type', async () => {
    answer = path.join(root, 'pasted.png')
    await saveMedia(`data:image/png;base64,${PNG.toString('base64')}`, undefined, deps)
    expect(asked[0]!.defaultPath).toBe(path.join(downloads, 'image.png'))
    expect(fs.readFileSync(answer)).toEqual(PNG)
  })

  it('saves a local media file by its name; a non-media path is refused', async () => {
    const local = path.join(root, 'My Shot.png')
    fs.writeFileSync(local, PNG)
    answer = path.join(root, 'out.png')
    await saveMedia(relay(local), undefined, deps)
    expect(asked[0]!.defaultPath).toBe(path.join(downloads, 'my-shot.png'))
    expect(fs.readFileSync(answer)).toEqual(PNG)
    await expect(saveMedia(relay('/etc/passwd'), undefined, deps)).rejects.toMatchObject({
      code: 'media-unavailable',
    })
  })

  it('refuses a GLB (not an image or a video) before any dialog', async () => {
    await expect(saveMedia(relay('/drops/glb1/SECRETTOKEN'), 'Robot', deps)).rejects.toMatchObject({
      code: 'not-media',
    })
    expect(asked).toEqual([])
  })

  it('says Relay is down without repeating the drop URL', async () => {
    deps = { ...deps, media: { ...deps.media, servePort: () => null } }
    const err = await saveMedia(relay('/drops/x/SECRETTOKEN'), undefined, deps).catch((e) => e)
    expect(err).toMatchObject({ code: 'media-unavailable' })
    expect(String(err.message)).not.toContain('SECRETTOKEN')
  })

  it('reports a missing drop without its URL', async () => {
    const err = await saveMedia(relay('/drops/gone/SECRETTOKEN'), undefined, deps).catch((e) => e)
    expect(err).toMatchObject({ code: 'media-unavailable' })
    expect(String(err.message)).not.toContain('SECRETTOKEN')
  })
})

describe('copyMedia', () => {
  it('copies an image as its bytes; a video is never copied', async () => {
    await copyMedia(relay('/drops/pic1/SECRETTOKEN'), 'image', deps)
    expect(images).toEqual([PNG])
    await expect(copyMedia(relay('/drops/vid1/SECRETTOKEN'), 'image', deps)).rejects.toMatchObject({
      code: 'not-media',
    })
  })

  it('copies the address: a drop on the host, a URL as is, a local file as its path', async () => {
    await copyMedia(relay('/drops/vid1/SECRETTOKEN'), 'address', deps)
    await copyMedia(relay('https://example.com/a.png?x=1'), 'address', deps)
    await copyMedia(relay('~/clip.mov'), 'address', deps)
    expect(texts).toEqual([
      `http://127.0.0.1:${port}/drops/vid1/SECRETTOKEN`,
      'https://example.com/a.png?x=1',
      path.join(root, 'clip.mov'),
    ])
  })

  it('a pasted image has no address', async () => {
    const write = vi.fn()
    await expect(
      copyMedia(`data:image/png;base64,${PNG.toString('base64')}`, 'address', {
        ...deps,
        writeText: write,
      }),
    ).rejects.toMatchObject({ code: 'no-address' })
    expect(write).not.toHaveBeenCalled()
  })
})
