import type { StudioAsset } from '@evaos/contract'

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
