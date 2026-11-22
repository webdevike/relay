/**
 * How big a 3D model (GLB) chat may open, on the phone and the desktop. A model opens only on a tap
 * and one at a time; past this size it never opens: parsed meshes and decoded textures take many
 * times the file's bytes, and a few 20 MB scans got the iPhone app killed (2026-11-22).
 */
export const MODEL_MAX_BYTES = 40 * 1024 * 1024

/** A file size as Isaac reads it: `840 KB`, `14.8 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const mb = bytes / (1024 * 1024)
  return `${mb < 100 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** What a model frame says instead of opening a model of `bytes`. */
export function modelTooLargeText(bytes: number): string {
  return `Too large to open in 3D: ${formatBytes(bytes)} (the limit is ${MODEL_MAX_BYTES / (1024 * 1024)} MB).`
}
