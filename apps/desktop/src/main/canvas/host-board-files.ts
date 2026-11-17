// The boards on a thin client: they live in the Mini's boards folder, so the board store, card
// images and pasted images read and write them through the Mini's Relay Host with
// `canvas.file.req {rid, op, ...}`, answered by `canvas.file.res` with the same rid (relay
// packages/protocol canvas-files.ts). A board changed by anyone else comes back as
// `canvas.files.changed` once this launch asked for them with `canvas.files.watch`.
import { randomUUID } from 'node:crypto'
import {
  CANVAS_FILES_FEATURE,
  CanvasFileRes,
  MAX_CANVAS_ASSET_BYTES,
  type CanvasFileReq,
} from '@relay/protocol'
import { NOT_CONNECTED, type RelayFeatures, type RelayFrames } from '../relay/client'
import type { BoardFiles } from './board-files'
import { coded } from './board-text'

/** A host connected but without CANVAS_FILES_FEATURE. */
export const OLD_HOST_CANVAS =
  'The Mini’s Relay Host can’t share its boards yet. Update it to open them on this Mac.'
export const NO_CANVAS_ANSWER = 'The Mini’s Relay Host didn’t answer in time.'
export const CANVAS_FILE_TIMEOUT_MS = 15_000

export interface HostBoardFiles extends BoardFiles {
  /** This launch's id: sent with every write, echoed in `canvas.files.changed`. */
  readonly origin: string
  /** An image file by `src` relative to the host's boards folder. */
  readAsset(src: string): Promise<Buffer>
  /** Writes an image file at `src` relative to the host's boards folder. */
  writeAsset(src: string, bytes: Buffer): Promise<void>
}

type Ask = Omit<CanvasFileReq, 't' | 'rid'>

/** The host's refusal codes as the IPC codes the Canvas page shows. */
const CODES: Record<NonNullable<CanvasFileRes['code']>, string> = {
  'not-found': 'not-found',
  invalid: 'invalid-input',
  'too-large': 'unsupported',
  internal: 'host-refused',
}

/**
 * Board files on the host. Fails with `relay-unavailable` (NOT_CONNECTED) while there is no
 * connection, `host-outdated` (OLD_HOST_CANVAS) when the host does not serve boards, `timeout`
 * when it does not answer.
 */
export function createHostBoardFiles(
  frames: RelayFrames & RelayFeatures,
  opts: { origin?: string; timeoutMs?: number } = {},
): HostBoardFiles {
  const origin = opts.origin ?? `relay-desktop-${randomUUID().slice(0, 8)}`
  const timeoutMs = opts.timeoutMs ?? CANVAS_FILE_TIMEOUT_MS
  let seq = 0

  function req(ask: Ask): Promise<CanvasFileRes> {
    if (!frames.hostHas(CANVAS_FILES_FEATURE)) {
      // hostHas is false both offline and on an old host; a ping goes out only on a live connection.
      const connected = frames.sendFrame({ t: 'ping', ts: Date.now() })
      return Promise.reject(
        connected
          ? coded(OLD_HOST_CANVAS, 'host-outdated')
          : coded(NOT_CONNECTED, 'relay-unavailable'),
      )
    }
    seq += 1
    const rid = `relay-desktop-canvas-${Date.now().toString(36)}-${seq}`
    const { promise, resolve, reject } = Promise.withResolvers<CanvasFileRes>()
    const timer = setTimeout(() => {
      off()
      reject(coded(NO_CANVAS_ANSWER, 'timeout'))
    }, timeoutMs)
    const off = frames.onFrame((f) => {
      if (f.t !== 'canvas.file.res' || f.rid !== rid) return
      clearTimeout(timer)
      off()
      const res = CanvasFileRes.safeParse(f)
      if (!res.success) {
        reject(coded('The Mini’s Relay Host sent an answer this app can’t read.', 'host-refused'))
      } else if (res.data.ok) {
        resolve(res.data)
      } else {
        const code = CODES[res.data.code ?? 'internal']
        reject(coded(res.data.error ?? 'The Mini’s Relay Host refused that.', code))
      }
    })
    if (!frames.sendFrame({ t: 'canvas.file.req', rid, ...ask })) {
      clearTimeout(timer)
      off()
      reject(coded(NOT_CONNECTED, 'relay-unavailable'))
    }
    return promise
  }

  return {
    origin,
    async read(slug) {
      return (await req({ op: 'read', slug })).text ?? null
    },
    async write(slug, text, commit) {
      commit()
      await req({ op: 'write', slug, text, origin })
    },
    async list() {
      return (await req({ op: 'list' })).files ?? []
    },
    async remove(slug) {
      await req({ op: 'remove', slug, origin })
    },
    async exists(slug) {
      return (await req({ op: 'exists', slug })).exists === true
    },
    async appendHistory(slug, line) {
      await req({ op: 'history', slug, text: line })
    },
    async readAsset(src) {
      const { data } = await req({ op: 'asset.read', src })
      if (data === undefined) throw coded(`No image at ${src}.`, 'not-found')
      return Buffer.from(data, 'base64')
    },
    async writeAsset(src, bytes) {
      if (bytes.length > MAX_CANVAS_ASSET_BYTES) {
        throw coded(
          'That image is larger than 12 MB, too large to send to the Mini.',
          'unsupported',
        )
      }
      await req({ op: 'asset.write', src, data: bytes.toString('base64'), origin })
    },
  }
}

/**
 * Follows the host's boards: asks for `canvas.files.watch` now (when connected) and after every
 * (re)connect, which also reloads the list (`changed(null)`) since boards may have changed while
 * away. Changes this launch wrote (`origin`) are dropped: the store's own writes never echo back.
 * `connected` runs whenever a host that serves boards is connected. Answers the unsubscribe.
 */
export function followHostBoards(
  frames: RelayFrames & RelayFeatures,
  origin: string,
  on: { changed(slug: string | null): void; connected(): void },
): () => void {
  const watch = (): boolean =>
    frames.hostHas(CANVAS_FILES_FEATURE) && frames.sendFrame({ t: 'canvas.files.watch' })
  const off = frames.onFrame((f) => {
    if (f.t === 'welcome') {
      const served = watch()
      on.changed(null)
      if (served) on.connected()
      return
    }
    if (f.t !== 'canvas.files.changed' || f.origin === origin) return
    on.changed(typeof f.slug === 'string' ? f.slug : null)
  })
  if (watch()) on.connected()
  return off
}
