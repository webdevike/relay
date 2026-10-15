import { MantineProvider } from '@mantine/core'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScrollArea } from './ScrollArea'
import { getScroll, resetScrollMemory, setScroll } from './scroll-memory'

let scrollHeight = 500
const clientHeight = 200

beforeEach(() => {
  resetScrollMemory()
  scrollHeight = 500
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
})

function mount(scrollKey?: string) {
  const r = render(
    <MantineProvider>
      <ScrollArea scrollKey={scrollKey} data-testid="sa">
        <div style={{ height: 500 }}>content</div>
      </ScrollArea>
    </MantineProvider>,
  )
  const root = r.getByTestId('sa')
  const viewport = root.querySelector<HTMLElement>('.eva-scroll-viewport')!
  return { r, root, viewport }
}

function scrollTo(viewport: HTMLElement, top: number): void {
  act(() => {
    viewport.scrollTop = top
    viewport.dispatchEvent(new Event('scroll'))
  })
}

describe('ScrollArea', () => {
  it('fades follow the scroll position', () => {
    const { root, viewport } = mount()
    expect(root.dataset.fadeTop).toBe('false')
    expect(root.dataset.fadeBottom).toBe('true')
    scrollTo(viewport, 100)
    expect(root.dataset.fadeTop).toBe('true')
    expect(root.dataset.fadeBottom).toBe('true')
    scrollTo(viewport, 300)
    expect(root.dataset.fadeTop).toBe('true')
    expect(root.dataset.fadeBottom).toBe('false')
  })

  it('shows no fades without overflow', () => {
    scrollHeight = 150
    const { root } = mount()
    expect(root.dataset.fadeTop).toBe('false')
    expect(root.dataset.fadeBottom).toBe('false')
  })

  it('restores and saves scrollTop per key', async () => {
    setScroll('page:a', 120)
    setScroll('page:b', 40)
    const a = mount('page:a')
    expect(a.viewport.scrollTop).toBe(120)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    scrollTo(a.viewport, 77)
    expect(getScroll('page:a')).toBe(77)
    expect(getScroll('page:b')).toBe(40)
  })
})
