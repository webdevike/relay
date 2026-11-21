import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { IS_MAC } from '@evaos/shell-core'
import { dispatchChord } from '../hotkeys/router'
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

/** The preload bridge's invoke: EvaModal tells main to hide the browser view, media actions save. */
const invoke = vi.fn()

describe('ImageViewer', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue({ ok: true, value: {} })
    ;(window as unknown as { eva: unknown }).eva = { invoke, on: vi.fn(() => () => undefined) }
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

  it('has a close button', async () => {
    const onClose = vi.fn()
    show(onClose)
    await screen.findByAltText('Image 1 of 2')
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('Download and Cmd+S save the image shown, named by its label', async () => {
    show()
    await screen.findByAltText('Image 1 of 2')
    fireEvent.click(screen.getByTestId('viewer-download'))
    expect(invoke).toHaveBeenCalledWith('media.save', { src: PNG, name: 'Image 1' })
    act(() => void fireEvent.keyDown(document, { key: 'ArrowRight' }))
    await screen.findByAltText('Image 2 of 2')
    invoke.mockClear()
    act(() => void dispatchChord('cmd+s', { fromGuest: false }))
    expect(invoke).toHaveBeenCalledWith('media.save', { src: PNG, name: 'Image 2' })
  })

  it('Cmd+C copies the image unless text owns the copy', async () => {
    show()
    await screen.findByAltText('Image 1 of 2')
    const cmdC = IS_MAC ? { key: 'c', metaKey: true } : { key: 'c', ctrlKey: true }
    act(() => void fireEvent.keyDown(document, cmdC))
    expect(invoke).toHaveBeenCalledWith('media.copy', { src: PNG, what: 'image' })
    invoke.mockClear()
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    act(() => void fireEvent.keyDown(input, cmdC))
    expect(invoke).not.toHaveBeenCalledWith('media.copy', expect.anything())
    input.remove()
  })

  it('a right-click opens the media menu; a pasted image has no address to copy', async () => {
    show()
    const img = await screen.findByAltText('Image 1 of 2')
    fireEvent.contextMenu(img, { clientX: 40, clientY: 50 })
    const menu = await screen.findByTestId('media-menu')
    expect(menu).toHaveAttribute('data-kind', 'image')
    expect(screen.getByTestId('media-menu-copy')).toHaveTextContent('Copy Image')
    expect(screen.queryByTestId('media-menu-address')).toBeNull()
    fireEvent.click(screen.getByTestId('media-menu-save'))
    expect(invoke).toHaveBeenCalledWith('media.save', { src: PNG, name: 'Image 1' })
    await waitFor(() => expect(screen.queryByTestId('media-menu')).toBeNull())
  })
})
