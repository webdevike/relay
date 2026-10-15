import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { ImageViewer } from './ImageViewer'

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg=='
const images = [
  { label: 'Image 1', src: PNG },
  { label: 'Image 2', src: PNG },
]

const show = (onClose = vi.fn(), start = 0) =>
  render(
    <MantineProvider>
      <ImageViewer images={images} start={start} opened onClose={onClose} />
    </MantineProvider>,
  )

describe('ImageViewer', () => {
  beforeEach(() => {
    // EvaModal tells main to hide the browser view; there is no preload bridge in jsdom.
    ;(window as unknown as { eva: unknown }).eva = {
      invoke: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      on: vi.fn(() => () => undefined),
    }
  })

  it('opens on the start index and moves with arrows within bounds', async () => {
    show()
    expect(await screen.findByAltText('Image 1 of 2')).toBeInTheDocument()
    act(() => void fireEvent.keyDown(document, { key: 'ArrowLeft' }))
    expect(screen.getByAltText('Image 1 of 2')).toBeInTheDocument()
    act(() => void fireEvent.keyDown(document, { key: 'ArrowRight' }))
    expect(await screen.findByAltText('Image 2 of 2')).toBeInTheDocument()
    act(() => void fireEvent.keyDown(document, { key: 'ArrowRight' }))
    expect(screen.getByAltText('Image 2 of 2')).toBeInTheDocument()
  })

  it('has a close button and no download control', async () => {
    const onClose = vi.fn()
    show(onClose)
    await screen.findByAltText('Image 1 of 2')
    expect(screen.queryByText(/download/i)).toBeNull()
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalled()
  })
})
