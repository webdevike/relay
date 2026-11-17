import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ChatImage } from './ChatImage'
import { IMAGE_DRAG_TYPE } from '../canvas/image-drop'

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg=='

describe('a chat image', () => {
  it('can be dragged onto the Canvas, carrying its picture', () => {
    render(
      <ChatImage
        image={{ label: 'shot', src: PNG }}
        index={0}
        total={1}
        onOpen={() => undefined}
      />,
    )
    const img = screen.getByAltText('Image 1 of 1')
    expect(img).toHaveAttribute('draggable', 'true')
    const setData = vi.fn()
    fireEvent.dragStart(img, { dataTransfer: { setData } })
    expect(setData).toHaveBeenCalledWith(IMAGE_DRAG_TYPE, PNG)
  })
})
