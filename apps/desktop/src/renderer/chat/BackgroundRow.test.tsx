import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { makeMessage } from '@evaos/chat-core/message'
import { MessageRow } from './MessageRow'
import { parseBackground } from './background-message'

const open = vi.hoisted(() => vi.fn())
vi.mock('../navigation/open-link', () => ({ openLink: open }))
vi.mock('../ipc', () => ({ invoke: vi.fn() }))

// Strings as they arrive in Nova's thread (session file samples).
const HEARTBEAT_ONE =
  "[From Nova's background jobs] Heartbeat: 1 new.\n[gmail] Google Developers: [Action Advised] Manage your unused OAuth clients and protect your information (2026-11-03T05:52:30Z)"
const HEARTBEAT_PROJECT =
  "[From Nova's background jobs] Heartbeat: 1 new.\n[project] Eva ICM watch: next step due (icm-watch)"
const HEARTBEAT_MANY = [
  "[From Nova's background jobs] Heartbeat: 3 new.",
  '[gmail] Anthropic, PBC: Your receipt from Anthropic, PBC #2773-5516-7485 (2026-10-21T20:44:34Z)',
  '[gmail] Anthropic: Your Max subscription is confirmed (2026-10-21T20:44:29Z)',
  '[work] Personal and work omp profiles in EvaOS and Relay (https://linear.app/eva/issue/ENG-1)',
].join('\n')
const ROLLOVER =
  "[From Polaris's background jobs] Rollover: fresh context, read work/eva/agents/polaris/thread.md"
const HEALTH =
  "[From Polaris's background jobs] Health: 1 problem(s).\n- eva-hillclimb run 2026-11-02T205349 ended done (omp exit 143)"
const AUTO_WORK =
  "[From Astra's background jobs] auto-work ENG-6648 replied to a coworker. Reply: Thanks Dana, moved the popover to a portal."
const STARTED =
  'Live canvas started on "Live UI demo" (board live-ui-demo, new). Isaac has a Join card in this chat; Nova in the room is this session, with this chat as context. Purpose: Show Isaac the new live UI cards'
const WRAP_UP =
  'Canvas "List view options" wrap-up: Nothing was said at the canvas; the board is unchanged.'
const EXCHANGE =
  'Canvas "Sidebar layout" · Isaac: can you find me screenshots?\nNova: Yes, handing that to Nova. She\'ll grab screenshots of Relay\'s sidebar.'
const REQUEST =
  '[Canvas request from Isaac] Grab screenshots of the sidebar and put them on the board.'
const HANDOFF = [
  '[From Nova\'s background jobs] [Relay Assist handoff] TEST Isaac said "TEST: hand this off" while looking at Linear.',
  "This is a TEST of Relay Assist's handoff: acknowledge it in one line and take no other action.",
  'Ticket: ENG-6309',
].join('\n')
const REACTED =
  '[Isaac reacted 👍 to your message: "Agreed, that\'s the right fix. I\'ve started a helper (Opus, high effort) to build…"]\n(Reactions are quiet feedback from Isaac: take them into account, no need to answer them.)'

const wrap = (text: string) =>
  render(
    <MantineProvider>
      <MessageRow m={makeMessage('u', 'user', text, { at: Date.now() - 5 * 60_000 })} />
    </MantineProvider>,
  )

describe('parseBackground', () => {
  it('leaves what Isaac typed alone', () => {
    expect(parseBackground('hello there')).toBeNull()
    expect(parseBackground('Canvas looks good to me')).toBeNull()
    expect(parseBackground('[a note] in brackets')).toBeNull()
    expect(parseBackground('')).toBeNull()
  })

  it('reads a heartbeat as per-source counts and its items', () => {
    const m = parseBackground(HEARTBEAT_MANY)
    expect(m).toMatchObject({
      kind: 'heartbeat',
      from: 'Nova',
      count: 3,
      sources: [
        { source: 'gmail', count: 2 },
        { source: 'work', count: 1 },
      ],
    })
    if (m?.kind !== 'heartbeat') throw new Error('not a heartbeat')
    expect(m.items[0]).toEqual({
      source: 'gmail',
      title: 'Anthropic, PBC: Your receipt from Anthropic, PBC #2773-5516-7485',
      meta: '2026-10-21T20:44:34Z',
      link: null,
    })
    expect(m.items[2]).toMatchObject({ link: 'https://linear.app/eva/issue/ENG-1' })
    expect(parseBackground(HEARTBEAT_ONE)).toMatchObject({
      kind: 'heartbeat',
      sources: [{ source: 'gmail', count: 1 }],
    })
    expect(parseBackground(HEARTBEAT_PROJECT)).toMatchObject({
      items: [{ source: 'project', title: 'Eva ICM watch: next step due', meta: 'icm-watch' }],
    })
  })

  it('summarizes one-off events on one line by source and first sentence', () => {
    expect(parseBackground(AUTO_WORK)).toMatchObject({
      icon: 'robot',
      summary: 'Astra · auto-work ENG-6648 replied to a coworker',
    })
    expect(parseBackground(ROLLOVER)).toMatchObject({
      icon: 'robot',
      summary: 'Polaris · Rollover: fresh context, read work/eva/agents/polaris/thread.md',
    })
    expect(parseBackground(HEALTH)).toMatchObject({ summary: 'Polaris · Health: 1 problem(s)' })
    expect(parseBackground(STARTED)).toMatchObject({
      icon: 'board',
      summary: 'Canvas · started "Live UI demo"',
    })
    expect(parseBackground(WRAP_UP)).toMatchObject({
      icon: 'board',
      summary:
        'Canvas "List view options" wrap-up · Nothing was said at the canvas; the board is unchanged',
    })
    expect(parseBackground(EXCHANGE)).toMatchObject({
      icon: 'chat',
      summary: 'Canvas "Sidebar layout" · Isaac · can you find me screenshots?',
    })
    expect(parseBackground(REQUEST)).toMatchObject({
      icon: 'board',
      summary:
        'Canvas request from Isaac · Grab screenshots of the sidebar and put them on the board',
    })
    expect(parseBackground(HANDOFF)).toMatchObject({
      icon: 'hand',
      summary: 'Relay Assist · TEST Isaac said "TEST: hand this off" while looking at Linear',
    })
    expect(parseBackground(REACTED)).toMatchObject({
      icon: 'reaction',
      summary: 'Isaac reacted 👍 to "Agreed, that\'s the right fix"',
    })
  })

  it('keeps the summary to a bounded single line', () => {
    const m = parseBackground(`[From Nova's background jobs] ${'long '.repeat(80)}`)
    expect(m?.kind === 'event' && m.summary.length).toBeLessThanOrEqual(200)
    expect(m?.kind === 'event' && m.summary).not.toContain('\n')
  })
})

describe('background rows in a chat', () => {
  it('shows a job as one quiet row, with no bubble, that opens its full text in place', () => {
    const { container } = wrap(AUTO_WORK)
    expect(container.querySelector('.eva-bubble')).toBeNull()
    const head = screen.getByRole('button', {
      name: /Astra · auto-work ENG-6648 replied to a coworker/,
    })
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(within(head).getByText('5m')).toBeTruthy()
    expect(screen.queryByTestId('background-body')).toBeNull()
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('background-body').textContent).toContain(
      'Reply: Thanks Dana, moved the popover to a portal.',
    )
    fireEvent.click(head)
    expect(screen.queryByTestId('background-body')).toBeNull()
  })

  it('renders markdown links in an opened event', () => {
    wrap("[From Nova's background jobs] Filed [ENG-1](https://linear.app/eva/issue/ENG-1) today.")
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('link', { name: 'ENG-1' }).getAttribute('href')).toBe(
      'https://linear.app/eva/issue/ENG-1',
    )
  })

  it('shows a heartbeat as source pills that open a list of items with links', () => {
    const { container } = wrap(HEARTBEAT_MANY)
    expect(container.querySelector('.eva-bubble')).toBeNull()
    expect(screen.getAllByTestId('background-pill').map((p) => p.textContent)).toEqual([
      'Gmail 2',
      'Work 1',
    ])
    expect(screen.queryByTestId('background-list')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Heartbeat from Nova, 3 new/ }))
    const items = screen.getAllByTestId('background-item')
    expect(items).toHaveLength(3)
    expect(items[1]!.textContent).toContain('Anthropic: Your Max subscription is confirmed')
    expect(items[1]!.textContent).toContain('2026-10-21T20:44:29Z')
    fireEvent.click(within(items[2]!).getByRole('link', { name: 'Open' }))
    expect(open).toHaveBeenCalledWith('https://linear.app/eva/issue/ENG-1', expect.anything())
  })

  it.each([STARTED, WRAP_UP, EXCHANGE, REQUEST, HANDOFF, REACTED, ROLLOVER, HEALTH])(
    'never shows a bubble for a background text',
    (text) => {
      const { container } = wrap(text)
      expect(container.querySelector('.eva-bubble')).toBeNull()
      expect(screen.getByTestId('background-event')).toBeTruthy()
    },
  )

  it('still shows what Isaac types as a bubble', () => {
    wrap('Anything I should know about?')
    expect(screen.getByText('Anything I should know about?').classList.contains('eva-bubble')).toBe(
      true,
    )
  })
})
