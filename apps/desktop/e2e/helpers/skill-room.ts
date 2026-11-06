// A stand-in for the Relay host's live skill document (relay apps/linux skills/room.ts): the open
// call's token and a y-websocket endpoint that serves one Y.Doc per skill, so the Editor tab has
// a real document to render. Sync only: a client's edits apply to the doc; awareness is ignored.
// Plugged into FakeRelayHost.extra.
import { createHash } from 'node:crypto'
import type http from 'node:http'
import type { Duplex } from 'node:stream'
import * as Y from 'yjs'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MESSAGE_SYNC = 0
const STEP1 = 0
const STEP2 = 1
const UPDATE = 2

const varuint = (n: number): number[] => {
  const out: number[] = []
  let v = n
  while (v > 127) {
    out.push(128 | (v & 127))
    v >>>= 7
  }
  out.push(v)
  return out
}

function readVaruint(b: Uint8Array, at: number): [number, number] {
  let n = 0
  let shift = 0
  let i = at
  for (;;) {
    const byte = b[i++]!
    n |= (byte & 127) << shift
    if (byte < 128) return [n >>> 0, i]
    shift += 7
  }
}

/** A sync message of `type` carrying `bytes`. */
const syncMessage = (type: number, bytes: Uint8Array): Buffer =>
  Buffer.concat([Buffer.from([MESSAGE_SYNC, type, ...varuint(bytes.length)]), bytes])

function send(socket: Duplex, payload: Buffer): void {
  const len = payload.length
  const head =
    len < 126
      ? Buffer.from([0x82, len])
      : len < 65_536
        ? Buffer.from([0x82, 126, len >> 8, len & 0xff])
        : Buffer.concat([Buffer.from([0x82, 127, 0, 0, 0, 0]), Buffer.from(varuint32(len))])
  socket.write(Buffer.concat([head, payload]))
}

const varuint32 = (n: number): number[] => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
]

export class SkillRooms {
  private readonly docs = new Map<string, Y.Doc>()

  /** Serves `doc` as the live document of skill `name`. */
  add(name: string, doc: Y.Doc): void {
    this.docs.set(name, doc)
  }

  /** `POST /skills/<name>/open`: the room's token. */
  http(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const name = /^\/skills\/([^/]+)\/open$/.exec(url.pathname)?.[1]
    if (req.method !== 'POST' || name === undefined || !this.docs.has(decodeURIComponent(name)))
      return false
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ token: 'fake-skill-token' }))
    return true
  }

  /** `GET /skills/<name>/ws`: the y-websocket connection. */
  upgrade(req: http.IncomingMessage, socket: Duplex): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const name = /^\/skills\/([^/]+)\/ws$/.exec(url.pathname)?.[1]
    const key = req.headers['sec-websocket-key']
    const doc = name === undefined ? undefined : this.docs.get(decodeURIComponent(name))
    if (doc === undefined || typeof key !== 'string') return false
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    send(socket, syncMessage(STEP1, Y.encodeStateVector(doc)))
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 2) return
        const opcode = buffer[0]! & 0x0f
        let len = buffer[1]! & 0x7f
        let at = 2
        if (len === 126) {
          if (buffer.length < 4) return
          len = buffer.readUInt16BE(2)
          at = 4
        } else if (len === 127) {
          if (buffer.length < 10) return
          len = Number(buffer.readBigUInt64BE(2))
          at = 10
        }
        if (buffer.length < at + 4 + len) return
        const mask = buffer.subarray(at, at + 4)
        const body = Buffer.from(buffer.subarray(at + 4, at + 4 + len))
        for (let i = 0; i < body.length; i++) body[i]! ^= mask[i % 4]!
        buffer = buffer.subarray(at + 4 + len)
        if (opcode === 0x8) {
          socket.end(Buffer.from([0x88, 0]))
          return
        }
        if (opcode === 0x2) this.message(socket, doc, body)
      }
    })
    socket.on('error', () => socket.destroy())
    return true
  }

  private message(socket: Duplex, doc: Y.Doc, body: Uint8Array): void {
    if (body[0] !== MESSAGE_SYNC) return
    const type = body[1]!
    const [len, from] = readVaruint(body, 2)
    const bytes = body.subarray(from, from + len)
    if (type === STEP1) send(socket, syncMessage(STEP2, Y.encodeStateAsUpdate(doc, bytes)))
    else if (type === STEP2 || type === UPDATE) Y.applyUpdate(doc, bytes)
  }
}
