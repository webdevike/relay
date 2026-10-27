import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { Lightbox } from './Lightbox'
import type { LightboxImage } from './lightbox-model'

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg=='

const images: LightboxImage[] = [
  { id: 'a', src: 'a.png', title: 'Hero shot', caption: 'Above the fold' },
  { id: 'b', src: 'b.png', title: '', caption: 'Only a caption' },
  { id: 'c', src: 'c.png', title: 'Footer', caption: '' },
]

/** jsdom lays nothing out: the lightbox stage measures 1000x800, everything else 0. */
const sizeOf = (el: HTMLElement, w: number): number =>
  el.classList.contains('eva-lb-stage') ? w : 0

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return sizeOf(this, 1000)
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return sizeOf(this, 800)
    },
  })
})
afterAll(() => {
  // Back to Element.prototype's own getters.
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
})

/** Loads the shown picture as a 2000x1000 image. */
async function loadShown(): Promise<HTMLImageElement> {
  const img = (await screen.findByTestId('canvas-lightbox-img')) as HTMLImageElement
  Object.defineProperty(img, 'naturalWidth', { value: 2000 })
  Object.defineProperty(img, 'naturalHeight', { value: 1000 })
  act(() => void fireEvent.load(img))
  return img
}

const key = (k: string): void => act(() => void fireEvent.keyDown(document, { key: k }))
const zoom = (): string => screen.getByTestId('canvas-lightbox-zoom').textContent ?? ''

function show(openId: string | null = 'b', onClose = vi.fn()) {
  return render(
    <MantineProvider>
      <Lightbox slug="board" images={images} openId={openId} onClose={onClose} />
    </MantineProvider>,
  )
}

describe('Lightbox', () => {
  beforeEach(() => {
    Object.assign(window, {
      eva: {
        invoke: vi.fn((channel: string) =>
          Promise.resolve(
            channel === 'canvas.image'
              ? { ok: true, value: { dataUrl: PNG, width: 2000, height: 1000 } }
              : { ok: true, value: {} },
          ),
        ),
        on: vi.fn(() => () => undefined),
      },
    })
  })

  it('stays closed without an image to open', () => {
    show(null)
    expect(screen.queryByTestId('canvas-lightbox-stage')).toBeNull()
  })

  it('opens on the chosen image and steps through the board in order', async () => {
    show('b')
    expect(await screen.findByTestId('canvas-lightbox-title')).toHaveTextContent('Only a caption')
    expect(screen.getByTestId('canvas-lightbox-count')).toHaveTextContent('2 of 3')
    expect(screen.queryByTestId('canvas-lightbox-caption')).toBeNull()
    key('ArrowLeft')
    expect(screen.getByTestId('canvas-lightbox-title')).toHaveTextContent('Hero shot')
    expect(screen.getByTestId('canvas-lightbox-caption')).toHaveTextContent('Above the fold')
    expect(screen.getByTestId('canvas-lightbox-prev')).toBeDisabled()
    key('ArrowLeft')
    expect(screen.getByTestId('canvas-lightbox-count')).toHaveTextContent('1 of 3')
    fireEvent.click(screen.getByTestId('canvas-lightbox-next'))
    fireEvent.click(screen.getByTestId('canvas-lightbox-next'))
    expect(screen.getByTestId('canvas-lightbox-title')).toHaveTextContent('Footer')
    expect(screen.getByTestId('canvas-lightbox-next')).toBeDisabled()
    key('ArrowRight')
    expect(screen.getByTestId('canvas-lightbox-count')).toHaveTextContent('3 of 3')
  })

  it('fits on load, zooms with keys and the 1:1 button, and draws at the zoomed size', async () => {
    show('a')
    const img = await loadShown()
    // 2000x1000 in a 1000x800 stage fits at 50%.
    expect(zoom()).toBe('50%')
    expect(img.style.width).toBe('1000px')
    key('+')
    expect(zoom()).toBe('63%')
    key('0')
    expect(zoom()).toBe('50%')
    key('-')
    expect(zoom()).toBe('50%')
    fireEvent.click(screen.getByTestId('canvas-lightbox-actual'))
    expect(zoom()).toBe('100%')
    expect(img.style.width).toBe('2000px')
    expect(img.style.height).toBe('1000px')
    expect(screen.getByTestId('canvas-lightbox-stage')).toHaveAttribute('data-pannable', 'true')
    key('1')
    expect(zoom()).toBe('100%')
  })

  it('pans by dragging, held to the image edges', async () => {
    show('a')
    const img = await loadShown()
    key('1')
    const stage = screen.getByTestId('canvas-lightbox-stage')
    stage.setPointerCapture = () => undefined
    fireEvent.pointerDown(stage, { button: 0, clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(stage, { clientX: 900, clientY: -40, pointerId: 1 })
    fireEvent.pointerUp(stage, { pointerId: 1 })
    expect(img.style.transform).toBe('translate(calc(-50% + 500px), calc(-50% + -40px))')
  })

  it('a new image opens fit again', async () => {
    show('a')
    await loadShown()
    key('1')
    expect(zoom()).toBe('100%')
    key('ArrowRight')
    await loadShown()
    expect(zoom()).toBe('50%')
  })

  it('closes from its close button', async () => {
    const onClose = vi.fn()
    show('a', onClose)
    await screen.findByTestId('canvas-lightbox-title')
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalled()
  })
})
