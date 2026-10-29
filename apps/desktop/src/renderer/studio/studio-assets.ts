import type { StudioAsset, StudioImage, StudioState } from '@evaos/contract'

/** Every asset the host keeps (outputs and uploads), by id. */
export function assetIndex(state: StudioState): ReadonlyMap<string, StudioAsset> {
  const index = new Map<string, StudioAsset>()
  for (const upload of state.uploads) index.set(upload.id, upload)
  for (const job of state.jobs) for (const output of job.outputs) index.set(output.id, output)
  return index
}

/** Images that can go into a slot: finished image outputs and uploads, newest first. */
export function pickableImages(state: StudioState): StudioAsset[] {
  const outputs = state.jobs.flatMap((j) =>
    j.state === 'done' ? j.outputs.filter((o) => o.kind === 'image') : [],
  )
  return [...outputs, ...state.uploads].sort((a, b) => b.createdAt - a.createdAt)
}

const UPLOAD_TYPES: Record<string, StudioImage['mimeType']> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/webp': 'image/webp',
}

/** The host takes at most 6 MB of base64, about 4.5 MB of image. */
export const MAX_UPLOAD_BYTES = Math.floor((6 * 1024 * 1024 * 3) / 4)

/** A dropped or chosen image file as the host's upload takes it; throws with a line for the UI. */
export async function readImageFile(file: File): Promise<StudioImage> {
  const mimeType = UPLOAD_TYPES[file.type]
  if (!mimeType) throw new Error('Studio takes PNG, JPEG or WebP images.')
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('That image is over 4.5 MB.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return { mimeType, data: btoa(binary) }
}

const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
}

/** The file name a download gets. */
export function downloadName(asset: StudioAsset): string {
  return `studio-${asset.id}${EXT[asset.mimeType] ?? ''}`
}

/** "5 s", "1:05": a video's length on its tile. */
export function durationLabel(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "1,240 credits". */
export function creditsLabel(n: number): string {
  return `${n.toLocaleString('en-US')} credits`
}
