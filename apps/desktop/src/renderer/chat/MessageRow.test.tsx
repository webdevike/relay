import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { makeMessage } from '@evaos/chat-core/message'
import { MessageRow } from './MessageRow'

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
})
