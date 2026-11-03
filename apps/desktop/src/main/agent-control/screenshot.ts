import { nativeImage, WebContentsView, type BaseWindow } from 'electron'

/**
 * Copies `src` (BGRA, `sw` x `sh`) into `dst` (BGRA, `dw` x `dh`) at pixel (`x`, `y`), clipped.
 * Exported for tests.
 */
export function blit(
  dst: Buffer,
  dw: number,
  dh: number,
  src: Buffer,
  sw: number,
  sh: number,
  x: number,
  y: number,
): void {
  const x0 = Math.max(0, x)
  const x1 = Math.min(dw, x + sw)
  if (x1 <= x0) return
  for (let row = Math.max(0, y); row < Math.min(dh, y + sh); row++) {
    const s = ((row - y) * sw + (x0 - x)) * 4
    src.copy(dst, (row * dw + x0) * 4, s, s + (x1 - x0) * 4)
  }
}

/**
 * The window as PNG: the shell page with every visible child view (the browser tab, docked
 * DevTools) drawn over it at its bounds. capturePage reads the compositor, so the window is never
 * shown, raised or focused.
 */
export async function captureWindow(win: BaseWindow, shell: WebContentsView): Promise<Buffer> {
  const base = await shell.webContents.capturePage()
  const scale = base.getScaleFactors()[0] ?? 1
  const { width, height } = base.getSize(scale)
  const bitmap = base.toBitmap({ scaleFactor: scale })
  if (bitmap.length !== width * height * 4) return base.toPNG()

  for (const child of win.contentView.children) {
    if (child === shell || !(child instanceof WebContentsView) || !child.getVisible()) continue
    const b = child.getBounds()
    if (b.width === 0 || b.height === 0 || child.webContents.isDestroyed()) continue
    const img = await child.webContents.capturePage()
    const s = img.getSize(scale)
    const px = img.toBitmap({ scaleFactor: scale })
    if (px.length !== s.width * s.height * 4) continue
    blit(
      bitmap,
      width,
      height,
      px,
      s.width,
      s.height,
      Math.round(b.x * scale),
      Math.round(b.y * scale),
    )
  }
  return nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: scale }).toPNG()
}
