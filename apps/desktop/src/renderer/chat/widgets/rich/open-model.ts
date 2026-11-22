/**
 * The one open 3D model in the app (model-viewer.machine.ts): opening a model closes the one open
 * before it, so at most one GLB is downloaded into memory and one WebGL context is live.
 */
let openModel: (() => void) | null = null

/** `close` belongs to the model opening now; the model open before it closes. */
export function claimOpenModel(close: () => void): void {
  const previous = openModel
  openModel = close
  if (previous !== null && previous !== close) previous()
}

/** The model that `close` belongs to closed or went away. */
export function releaseOpenModel(close: () => void): void {
  if (openModel === close) openModel = null
}
