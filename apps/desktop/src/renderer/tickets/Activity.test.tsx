import { MantineProvider } from '@mantine/core'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TicketComment, TicketDetail } from '@relay/protocol'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))
vi.mock('@mantine/notifications', () => ({ notifications: { show: () => {}, hide: () => {} } }))

import { Activity, TicketDescription } from './Activity'
import type { TicketData } from './ticket-data'

const pal = { id: 'u-pal', name: 'Pal Lee', avatarUrl: null }
const me = { id: 'u-me', name: 'Isaac', avatarUrl: null }

const comment = (id: string, at: number, over: Partial<TicketComment> = {}): TicketComment => ({
  id,
  parentId: null,
  documentContentId: null,
  quotedText: null,
  author: pal,
  body: `Comment ${id}`,
  at,
  editedAt: null,
  resolvedAt: null,
  resolvingUser: null,
  reactions: [],
  url: `https://linear.app/x/issue/ENG-1#comment-${id}`,
  ...over,
})

const detail = {
  key: 'ENG-1',
  id: 'issue-1',
  title: 'Sample',
  url: 'https://linear.app/x/issue/ENG-1/sample',
  description: 'See ![shot](https://uploads.linear.app/a/b/shot.png "w=120")',
  state: { id: 's', name: 'In Progress', type: 'started', color: '#fff' },
  team: { id: 'team-eng', key: 'ENG' },
  project: null,
  assignee: me,
  creator: pal,
  comments: [
    comment('mine', 1, { author: me, body: 'My root' }),
    comment('r-1', 2, { parentId: 'mine', body: 'A reply' }),
    comment('r-2', 3, { parentId: 'mine', body: '👍' }),
    comment('theirs', 4, { body: 'Their root', reactions: [{ emoji: '+1', users: [pal] }] }),
  ],
} as unknown as TicketDetail

const dataOf = (over: Partial<TicketData> = {}): TicketData => ({
  key: 'ENG-1',
  detail,
  source: 'host',
  unavailable: null,
  writeMode: 'gate',
  me: { linearViewerId: 'u-me', name: 'Isaac' },
  refresh: vi.fn(),
  ...over,
})

const host = (v: object) => Promise.resolve({ ok: true, value: { source: 'host', ...v } })
const calls = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel)

function gate(): void {
  invoke.mockImplementation((channel: string, input: { opId?: string }) => {
    if (channel === 'tickets.prepare')
      return host({ approval: { id: 'appr', expiresAt: Date.now() + 60_000, summary: 'Write it' } })
    if (channel === 'tickets.commit')
      return host({ outcome: { opId: input.opId, state: 'done', result: { id: 'posted-1' } } })
    if (channel === 'reviews.astraAsk')
      return Promise.resolve({
        ok: true,
        value: {
          url: 'u',
          title: 't',
          file: null,
          turns: [],
          working: true,
          waiting: null,
          error: null,
        },
      })
    if (channel === 'reviews.linearComment')
      return Promise.resolve({ ok: true, value: { url: 'u' } })
    return Promise.resolve({ ok: true, value: null })
  })
}

const view = (data: TicketData) =>
  render(
    <MantineProvider>
      <Activity data={data} focusCommentId={null} />
    </MantineProvider>,
  )

const commentEl = (id: string) =>
  screen.getAllByTestId('ticket-comment').find((el) => el.dataset.commentId === id)!

async function menuOf(id: string): Promise<string[]> {
  await userEvent.click(within(commentEl(id)).getByTestId('comment-menu'))
  const items = await screen.findAllByRole('menuitem')
  return items.map((i) => i.getAttribute('data-testid')!.replace('comment-action-', ''))
}

// jsdom has no layout: the private thread scrolls its newest reply into view.
Element.prototype.scrollIntoView = () => {}

afterEach(() => invoke.mockReset())

describe('Activity', () => {
  it('threads replies under their root and renders the description image at its width', async () => {
    gate()
    view(dataOf())
    const threads = screen.getAllByTestId('ticket-thread')
    expect(threads.map((t) => t.dataset.rootId)).toEqual(['mine', 'theirs'])
    expect(within(threads[0]!).getAllByTestId('ticket-comment')).toHaveLength(3)
    render(
      <MantineProvider>
        <TicketDescription data={dataOf()} />
      </MantineProvider>,
    )
    const img = screen.getByTestId('ticket-description').querySelector('img')!
    expect(img.style.maxWidth).toBe('min(120px, 100%)')
  })

  it('menus follow ownership: own root has edit, resolve, delete; theirs does not', async () => {
    gate()
    view(dataOf())
    expect(await menuOf('mine')).toEqual([
      'edit',
      'resolve',
      'copyLink',
      'copyMarkdown',
      'newIssue',
      'delete',
    ])
    cleanup()
    view(dataOf())
    expect(await menuOf('theirs')).toEqual(['resolve', 'copyLink', 'copyMarkdown', 'newIssue'])
  })

  it('without the gate only copies are offered and reactions do not toggle', async () => {
    gate()
    view(dataOf({ writeMode: 'legacy' }))
    expect(await menuOf('mine')).toEqual(['copyLink', 'copyMarkdown'])
    expect(within(commentEl('theirs')).getByTestId('comment-reaction')).toBeDisabled()
  })

  it('deleting a root confirms with its replies disclosed, then commits once', async () => {
    gate()
    const data = dataOf()
    view(data)
    await menuOf('mine')
    await userEvent.click(screen.getByTestId('comment-action-delete'))
    expect(await screen.findByText(/This also deletes its 2 replies/)).toBeTruthy()
    expect(calls('tickets.prepare')[0]![1]).toEqual({
      mutation: { kind: 'deleteComment', commentId: 'mine', replyCount: 2 },
    })
    expect(calls('tickets.commit')).toHaveLength(0)
    await userEvent.click(screen.getByTestId('review-confirm-post'))
    await waitFor(() => expect(data.refresh).toHaveBeenCalled())
    expect(calls('tickets.commit')).toHaveLength(1)
    expect(screen.getAllByTestId('ticket-thread').map((t) => t.dataset.rootId)).toEqual(['theirs'])
  })

  it('a comment shows the exact text to confirm, commits once and shows once', async () => {
    gate()
    const data = dataOf()
    view(data)
    await userEvent.type(screen.getByTestId('ticket-composer'), 'Ship it')
    await userEvent.click(screen.getByTestId('ticket-composer-send'))
    expect((await screen.findByTestId('review-confirm-text')).textContent).toBe('Ship it')
    expect(calls('tickets.commit')).toHaveLength(0)
    await userEvent.click(screen.getByTestId('review-confirm-post'))
    await waitFor(() => expect(data.refresh).toHaveBeenCalled())
    expect(calls('tickets.commit')).toHaveLength(1)
    expect(calls('tickets.commit')[0]![1]).toMatchObject({
      approvalId: 'appr',
      mutation: { kind: 'comment', issueId: 'issue-1', body: 'Ship it' },
    })
    expect(commentEl('posted-1')).toBeTruthy()
    expect((screen.getByTestId('ticket-composer') as HTMLTextAreaElement).value).toBe('')
  })

  it('a refused post keeps the draft and says why', async () => {
    invoke.mockImplementation((channel: string) =>
      channel === 'tickets.prepare'
        ? host({ refused: { code: 'writesOff', message: 'Writing to Linear is off on this host' } })
        : Promise.resolve({ ok: true, value: null }),
    )
    view(dataOf())
    await userEvent.type(screen.getByTestId('ticket-composer'), 'Ship it')
    await userEvent.click(screen.getByTestId('ticket-composer-send'))
    expect((await screen.findByTestId('mutation-notice')).textContent).toContain(
      'Writing to Linear is off',
    )
    expect((screen.getByTestId('ticket-composer') as HTMLTextAreaElement).value).toBe('Ship it')
    expect(calls('tickets.commit')).toHaveLength(0)
  })

  it('@Astra stays private: Only you, then the private ask and no gate write', async () => {
    gate()
    view(dataOf())
    await userEvent.type(screen.getByTestId('ticket-composer'), '@Astra what is left?')
    expect(screen.getByTestId('composer-private').textContent).toContain('Only you')
    await userEvent.click(screen.getByTestId('ticket-composer-send'))
    await waitFor(() => expect(calls('reviews.astraAsk')).toHaveLength(1))
    expect(calls('reviews.astraAsk')[0]![1]).toMatchObject({
      text: '@Astra what is left?',
      label: 'ENG-1',
    })
    expect(calls('tickets.prepare')).toHaveLength(0)
    expect(calls('tickets.commit')).toHaveLength(0)
  })

  it('a person and an assistant: told to write people separately, still private', async () => {
    gate()
    view(dataOf())
    await userEvent.type(screen.getByTestId('ticket-composer'), '@Pal Lee and @Nova look')
    expect(screen.getByTestId('composer-private').textContent).toContain(
      'This stays private in Relay. Write a separate comment for people.',
    )
  })

  it('legacy mode posts through reviews.linearComment after the confirm; none hides the composer', async () => {
    gate()
    const data = dataOf({ writeMode: 'legacy' })
    const { unmount } = view(data)
    await userEvent.type(screen.getByTestId('ticket-composer'), 'Hi')
    await userEvent.click(screen.getByTestId('ticket-composer-send'))
    await userEvent.click(await screen.findByTestId('review-confirm-post'))
    await waitFor(() => expect(calls('reviews.linearComment')).toHaveLength(1))
    expect(calls('reviews.linearComment')[0]![1]).toEqual({
      issueId: 'issue-1',
      parentId: null,
      body: 'Hi',
    })
    expect(calls('tickets.prepare')).toHaveLength(0)
    unmount()
    view(dataOf({ writeMode: 'none' }))
    expect(screen.queryByTestId('ticket-composer')).toBeNull()
  })

  it('a reaction click sets Isaac’s own (desired state), without a confirm', async () => {
    gate()
    view(dataOf())
    await userEvent.click(within(commentEl('theirs')).getByTestId('comment-reaction'))
    await waitFor(() => expect(calls('tickets.commit')).toHaveLength(1))
    expect(calls('tickets.commit')[0]![1]).toMatchObject({
      mutation: { kind: 'react', commentId: 'theirs', emoji: '+1', on: true },
    })
    expect(calls('tickets.prepare')).toHaveLength(0)
  })

  it('#comment-<id> opens a resolved thread, scrolls to the comment and flashes it', async () => {
    gate()
    const scrolled: Element[] = []
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    const resolved = {
      ...detail,
      comments: detail.comments.map((c) => (c.id === 'mine' ? { ...c, resolvedAt: 5 } : c)),
    }
    render(
      <MantineProvider>
        <Activity data={dataOf({ detail: resolved })} focusCommentId="r-1" />
      </MantineProvider>,
    )
    await waitFor(() => expect(commentEl('r-1').dataset.flash).toBe('true'))
    expect(scrolled).toContain(commentEl('r-1'))
    expect(screen.queryByTestId('ticket-thread-resolved')).toBeNull()
    Element.prototype.scrollIntoView = () => {}
  })

  it('editing Isaac’s comment saves inline without a confirm', async () => {
    gate()
    view(dataOf())
    await menuOf('mine')
    await userEvent.click(screen.getByTestId('comment-action-edit'))
    const box = await screen.findByTestId('comment-edit-box')
    await userEvent.clear(box)
    await userEvent.type(box, 'Better words')
    await userEvent.click(screen.getByTestId('comment-edit-save'))
    await waitFor(() => expect(calls('tickets.commit')).toHaveLength(1))
    expect(calls('tickets.commit')[0]![1]).toMatchObject({
      mutation: { kind: 'editComment', commentId: 'mine', body: 'Better words' },
    })
    expect(calls('tickets.prepare')).toHaveLength(0)
    expect(await within(commentEl('mine')).findByText('Better words')).toBeTruthy()
  })
})
