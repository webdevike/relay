import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { makeMessage, type ChatMessage } from '@evaos/chat-core/message'
import { QUICK_REACTIONS } from '@evaos/chat-core/reactions'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../../ipc', () => ({ invoke, on: () => () => {} }))

import { dismissTop } from '../../hotkeys/dismiss'
import { MessageRow } from '../MessageRow'
import { RELAY_DOWN, quoteOf } from './BubbleActions'
import { ReactionBar } from './ReactionBar'
import { ReactionScope, reactionsStore } from './reactions-store'

const THREAD = 'session:s1'
const writeText = vi.fn(async (_text: string) => {})
Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

const user = makeMessage('u1', 'user', 'Can you fix\nthe dock?', { at: 100 })
const reply = makeMessage('a1', 'assistant', 'Fixed **the dock**.', { at: 200 })

function show(m: ChatMessage, thread: string | null = THREAD) {
  const replyTo = vi.fn()
  render(
    <MantineProvider>
      <ReactionScope.Provider value={{ thread, reply: replyTo }}>
        <MessageRow m={m} />
      </ReactionScope.Provider>
    </MantineProvider>,
  )
  return { replyTo }
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue({ ok: true, value: { sent: true } })
  writeText.mockClear()
  reactionsStore.setState({ up: true, threads: {} })
})

describe('quoteOf', () => {
  it('quotes every line for the composer and leaves a blank line to type after', () => {
    expect(quoteOf('one\n\ntwo\n')).toBe('> one\n>\n> two\n\n')
  })
})

describe('reaction bar and badge', () => {
  it('opens the bar from the hover button: six quick picks and more, then reacts', async () => {
    show(user)
    expect(screen.queryByTestId('reaction-badge-u1')).toBeNull()
    fireEvent.click(screen.getByTestId('react-btn-u1'))
    const bar = await screen.findByTestId('reaction-bar')
    const picks = [...bar.querySelectorAll('[data-testid^="reaction-pick-"]')].map(
      (b) => b.textContent,
    )
    expect(picks).toEqual([...QUICK_REACTIONS])
    expect(
      await screen.findByRole('button', { name: 'More reactions', hidden: true }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('reaction-pick-👍'))
    expect(invoke).toHaveBeenCalledWith('reactions.react', {
      thread: THREAD,
      message: 'user@100',
      emoji: '👍',
      excerpt: 'Can you fix the dock?',
    })
    // Shown at once, before any snapshot.
    expect(screen.getByTestId('reaction-badge-u1')).toHaveTextContent('👍')
    await waitFor(() => expect(screen.queryByTestId('reaction-bar')).toBeNull())
  })

  it('highlights the current reaction; picking it again takes it off', async () => {
    reactionsStore.setState({
      threads: { [THREAD]: { 'assistant@200': { emoji: '❤️', excerpt: 'Fixed', at: 1 } } },
    })
    show(reply)
    const badge = screen.getByTestId('reaction-badge-a1')
    expect(badge).toHaveTextContent('❤️')
    expect(screen.queryByTestId('react-btn-a1')).toBeNull()
    fireEvent.click(badge)
    const heart = await screen.findByTestId('reaction-pick-❤️')
    expect(heart).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('reaction-pick-👍')).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(heart)
    expect(invoke).toHaveBeenCalledWith('reactions.react', {
      thread: THREAD,
      message: 'assistant@200',
      emoji: null,
      excerpt: 'Fixed **the dock**.',
    })
    expect(screen.queryByTestId('reaction-badge-a1')).toBeNull()
  })

  it('replaces the reaction with one from the more grid', async () => {
    reactionsStore.setState({
      threads: { [THREAD]: { 'user@100': { emoji: '👍', excerpt: '', at: 1 } } },
    })
    show(user)
    fireEvent.click(screen.getByTestId('reaction-badge-u1'))
    expect(screen.queryByTestId('reaction-grid')).toBeNull()
    fireEvent.click(await screen.findByTestId('reaction-more'))
    fireEvent.click(await screen.findByTestId('reaction-pick-🔥'))
    expect(invoke).toHaveBeenCalledWith(
      'reactions.react',
      expect.objectContaining({ message: 'user@100', emoji: '🔥' }),
    )
    expect(screen.getByTestId('reaction-badge-u1')).toHaveTextContent('🔥')
  })

  it('a host snapshot is authoritative, and a reaction Relay could not take is undone', async () => {
    invoke.mockResolvedValue({ ok: true, value: { sent: false } })
    show(user)
    fireEvent.click(screen.getByTestId('react-btn-u1'))
    fireEvent.click(await screen.findByTestId('reaction-pick-😂'))
    await waitFor(() => expect(screen.queryByTestId('reaction-badge-u1')).toBeNull())
    act(() =>
      reactionsStore.setState({
        threads: { [THREAD]: { 'user@100': { emoji: '‼️', excerpt: '', at: 1 } } },
      }),
    )
    expect(screen.getByTestId('reaction-badge-u1')).toHaveTextContent('‼️')
  })

  it('closes on Escape', async () => {
    show(user)
    fireEvent.click(screen.getByTestId('react-btn-u1'))
    await screen.findByTestId('reaction-bar')
    // The app's hotkey router turns Escape into the dismiss ladder.
    act(() => void dismissTop())
    await waitFor(() => expect(screen.queryByTestId('reaction-bar')).toBeNull())
  })

  it('closes on a click outside', async () => {
    show(user)
    fireEvent.click(screen.getByTestId('react-btn-u1'))
    await screen.findByTestId('reaction-bar')
    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(screen.queryByTestId('reaction-bar')).toBeNull())
  })

  it('while Relay is down: the button says why and opens nothing; the badge stays', async () => {
    reactionsStore.setState({ up: false })
    show(user)
    const btn = screen.getByTestId('react-btn-u1')
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    expect(btn).toHaveAccessibleName(RELAY_DOWN)
    fireEvent.click(btn)
    fireEvent.contextMenu(screen.getByTestId('bubble-u1'), { clientX: 5, clientY: 5 })
    await screen.findByTestId('bubble-menu')
    expect(screen.queryByTestId('reaction-bar')).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('reactions.react', expect.anything())
    act(() =>
      reactionsStore.setState({
        threads: { [THREAD]: { 'user@100': { emoji: '👍', excerpt: '', at: 1 } } },
      }),
    )
    expect(screen.getByTestId('reaction-badge-u1').tagName).toBe('SPAN')
  })

  it('a prompt omp has not stamped yet, or a chat without a thread, gets no react button', () => {
    show(makeMessage('sent-1', 'user', 'hi'))
    show(makeMessage('u2', 'user', 'yo', { at: 5 }), null)
    expect(screen.queryByTestId('react-btn-sent-1')).toBeNull()
    expect(screen.queryByTestId('react-btn-u2')).toBeNull()
    expect(screen.getByTestId('bubble-sent-1')).toBeInTheDocument()
  })

  it('tool, thinking and notice rows are never bubbles', () => {
    show(makeMessage('t1', 'thinking', 'hmm', { at: 1 }))
    show(makeMessage('n1', 'notice', 'Error', { at: 1 }))
    expect(screen.queryByTestId('bubble-t1')).toBeNull()
    expect(screen.queryByTestId('bubble-n1')).toBeNull()
  })
})

describe('ReactionBar', () => {
  // Rendered on its own: jsdom lays nothing out, so a popover's anchor reads as detached and
  // floating-ui hides the dropdown, which jsdom then refuses to focus into.
  it('moves between picks with the arrow keys, Home and End', () => {
    const onPick = vi.fn()
    render(<ReactionBar current="👍" onPick={onPick} />)
    const first = screen.getByRole('button', { name: 'React with ❤️' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(screen.getByRole('button', { name: 'Remove 👍' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(screen.getByTestId('reaction-more')).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(screen.getByTestId('reaction-more')).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'Enter' })
    fireEvent.click(first)
    expect(onPick).toHaveBeenCalledWith('❤️')
  })

  it('leads with a reaction from elsewhere that is not a quick pick', () => {
    render(<ReactionBar current="🦊" onPick={() => {}} />)
    const picks = screen
      .getAllByRole('button', { pressed: true })
      .map((b) => b.getAttribute('data-testid'))
    expect(picks).toEqual(['reaction-pick-🦊'])
    expect(screen.getByRole('toolbar').firstElementChild).toHaveAttribute(
      'data-testid',
      'reaction-pick-🦊',
    )
  })
})

describe('bubble context menu', () => {
  it('right-click opens the bar above and the menu at the pointer', async () => {
    show(reply)
    fireEvent.contextMenu(screen.getByTestId('bubble-a1'), { clientX: 40, clientY: 50 })
    expect(await screen.findByTestId('bubble-menu')).toBeInTheDocument()
    expect(await screen.findByTestId('reaction-bar')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByRole('menuitem', { hidden: true })).toHaveLength(4))
    // jsdom lays nothing out, so floating-ui reports the anchor detached and hides the dropdowns.
    const ids = screen
      .getAllByRole('menuitem', { hidden: true })
      .map((el) => el.getAttribute('data-testid'))
    expect(ids).toEqual([
      'bubble-menu-reply',
      'bubble-menu-copy',
      'bubble-menu-markdown',
      'bubble-menu-select',
    ])
  })

  it('Reply quotes the bubble into the composer', async () => {
    const { replyTo } = show(user)
    fireEvent.contextMenu(screen.getByTestId('bubble-u1'), { clientX: 1, clientY: 1 })
    fireEvent.click(await screen.findByTestId('bubble-menu-reply'))
    expect(replyTo).toHaveBeenCalledWith('> Can you fix\n> the dock?\n\n')
    await waitFor(() => expect(screen.queryByTestId('bubble-menu')).toBeNull())
    expect(screen.queryByTestId('reaction-bar')).toBeNull()
  })

  it('Copy and Copy as Markdown write the text; a prompt has no markdown item', async () => {
    show(reply)
    fireEvent.contextMenu(screen.getByTestId('bubble-a1'), { clientX: 1, clientY: 1 })
    fireEvent.click(await screen.findByTestId('bubble-menu-markdown'))
    expect(writeText).toHaveBeenLastCalledWith('Fixed **the dock**.')
    fireEvent.contextMenu(screen.getByTestId('bubble-a1'), { clientX: 1, clientY: 1 })
    fireEvent.click(await screen.findByTestId('bubble-menu-copy'))
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(writeText.mock.calls[1]![0]).not.toContain('**')
  })

  it('Select text selects the bubble', async () => {
    show(user)
    fireEvent.contextMenu(screen.getByTestId('bubble-u1'), { clientX: 1, clientY: 1 })
    fireEvent.click(await screen.findByTestId('bubble-menu-select'))
    expect(window.getSelection()?.toString()).toContain('the dock?')
  })
})
