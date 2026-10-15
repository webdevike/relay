import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { makeMessage } from '@evaos/chat-core/message'
import { MessageRow } from './MessageRow'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../ipc', () => ({ invoke }))
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg=='
const HASH = 'b'.repeat(64)

const wrap = (ui: React.ReactElement) => render(<MantineProvider>{ui}</MantineProvider>)

describe('MessageRow', () => {
  it('renders a user message as a bubble with its text', () => {
    wrap(<MessageRow m={makeMessage('u', 'user', 'hello there')} />)
    expect(screen.getByText('hello there')).toHaveClass('eva-bubble')
  })

  it('renders fenced code in a pre and keeps prose literal', () => {
    const { container } = wrap(
      <MessageRow m={makeMessage('a', 'assistant', 'a\n```ts\nconst x = 1\n```\nb')} />,
    )
    const pre = container.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre!.textContent).toBe('const x = 1')
    expect(container.textContent).toContain('a')
    expect(container.textContent).toContain('b')
    expect(container.querySelector('.eva-prose')).not.toBeNull()
  })

  it('renders an unterminated fence as code to the end', () => {
    const { container } = wrap(<MessageRow m={makeMessage('a', 'assistant', 'x\n```\nopen')} />)
    expect(container.querySelector('pre')!.textContent).toBe('open')
  })

  it('hides thinking text until the chevron is clicked', () => {
    wrap(<MessageRow m={makeMessage('t', 'thinking', 'secret musings')} />)
    expect(screen.getByText('Thinking')).toBeInTheDocument()
    expect(screen.queryByText('secret musings')).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('secret musings')).toBeInTheDocument()
  })

  it('shows tool name and status, input and result when expanded', () => {
    const m = makeMessage('c-tool0', 'tool', 'read', {
      detail: 'Reading notes',
      tool: { call: 'c', input: 'the input', result: 'the result', isError: false, status: 'done' },
    })
    wrap(<MessageRow m={m} />)
    expect(screen.getByText('read')).toBeInTheDocument()
    expect(screen.getByText('done')).toBeInTheDocument()
    expect(screen.queryByText('the result')).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('the input').tagName).toBe('PRE')
    expect(screen.getByText('the result').tagName).toBe('PRE')
  })

  it('renders HTML-looking text literally', () => {
    const { container } = wrap(<MessageRow m={makeMessage('u', 'user', '<b>x</b>')} />)
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain('<b>x</b>')
  })

  it('renders images as buttons with alt text and a reserved aspect box', () => {
    const m = makeMessage('u', 'user', 'look', {
      images: [
        { label: 'Image 1', src: PNG, width: 480, height: 240 },
        { label: 'Image 2', src: PNG },
      ],
    })
    const { container } = wrap(<MessageRow m={m} />)
    const buttons = container.querySelectorAll('button.eva-chat-image')
    expect(buttons).toHaveLength(2)
    expect(screen.getByAltText('Image 1 of 2')).toBeInTheDocument()
    expect(screen.getByAltText('Image 2 of 2')).toBeInTheDocument()
    expect((buttons[0] as HTMLElement).style.width).toBe('240px')
    expect((buttons[0] as HTMLElement).style.height).toBe('120px')
    expect((buttons[1] as HTMLElement).style.height).toBe('160px')
  })

  it('reads a blob token once and shows the data URL', async () => {
    invoke.mockResolvedValue({ ok: true, value: { dataUrl: PNG, width: 1, height: 1 } })
    const image = { label: 'Image 1', src: `blob:sha256:${HASH}` }
    wrap(<MessageRow m={makeMessage('u1', 'user', 'a', { images: [image] })} />)
    wrap(<MessageRow m={makeMessage('u2', 'user', 'b', { images: [image] })} />)
    await waitFor(() => expect(screen.getAllByAltText('Image 1 of 1')).toHaveLength(2))
    const imgs = screen.getAllByAltText('Image 1 of 1')
    expect(imgs[0]).toHaveAttribute('src', PNG)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('never renders an unsafe src', () => {
    const m = makeMessage('u', 'user', 'x', {
      images: [{ label: 'Image 1', src: 'data:image/svg+xml;base64,PHN2Zz4=' }],
    })
    const { container } = wrap(<MessageRow m={m} />)
    expect(container.querySelector('img')).toBeNull()
  })
})
