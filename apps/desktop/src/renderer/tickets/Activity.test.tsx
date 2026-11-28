import { MantineProvider } from '@mantine/core'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AstraItem } from '@evaos/contract'
import type { TicketComment, TicketDetail } from '@relay/protocol'

const invoke = vi.fn()
const listeners = new Map<string, Set<(v: unknown) => void>>()
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: (channel: string, cb: (v: unknown) => void) => {
    const set = listeners.get(channel) ?? new Set()
    listeners.set(channel, set)
    set.add(cb)
    return () => set.delete(cb)
  },
}))
/** Main's push of an item session (`reviews.astraUpdate`). */
const pushAstra = (item: AstraItem): void =>
  act(() => {
    for (const cb of listeners.get('reviews.astraUpdate') ?? []) cb(item)
  })
vi.mock('@mantine/notifications', () => ({ notifications: { show: () => {}, hide: () => {} } }))

import { Activity, TicketDescription, clippedWords } from './Activity'
import { assistantsStore } from '../assistants/assistants-store'
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

/** The comment's "..." menu items once it has opened (a loaded machine may take a while). */
async function menuOf(id: string): Promise<string[]> {
  await userEvent.click(within(commentEl(id)).getByTestId('comment-menu'))
  const items = await screen.findAllByRole('menuitem', {}, { timeout: 5_000 })
  return items.map((i) => i.getAttribute('data-testid')!.replace('comment-action-', ''))
}

// jsdom has no layout: the private thread scrolls its newest reply into view.
Element.prototype.scrollIntoView = () => {}

afterEach(() => {
  // Unmounted first: a registry change re-mounts the sessions, which read through `invoke`.
  cleanup()
  invoke.mockReset()
  assistantsStore.setState({ data: null })
})

/** The configured registry as main lists it (only the fields the composer reads matter here). */
const configure = (agents: Array<{ id: string; title: string }>): void =>
  assistantsStore.setState({
    data: { agents: agents as never, relayUp: true },
  })

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
  }, 15_000)

  it('without the gate only copies are offered and reactions do not toggle', async () => {
    gate()
    view(dataOf({ writeMode: 'legacy' }))
    const reaction = await within(commentEl('theirs')).findByTestId('comment-reaction')
    expect(reaction).toBeDisabled()
    expect(await menuOf('mine')).toEqual(['copyLink', 'copyMarkdown'])
  }, 15_000)

  it('deleting a root confirms with its replies disclosed, then commits once', async () => {
    gate()
    const data = dataOf()
    view(data)
    await menuOf('mine')
    await userEvent.click(screen.getByTestId('comment-action-delete'))
    expect(await screen.findByText(/This also deletes its 2 replies/)).toBeTruthy()
    expect(calls('tickets.prepare')[0]![1]).toEqual({
      viewerId: 'u-me',
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

  it('Nova and Astra each get the ask in their own session (`agent`), never the gate', async () => {
    gate()
    view(dataOf())
    const box = screen.getByTestId('ticket-composer') as HTMLTextAreaElement
    await userEvent.type(box, '@Nova check the plan')
    await userEvent.click(screen.getByTestId('ticket-composer-send'))
    await waitFor(() => expect(box.value).toBe(''))
    await userEvent.type(box, '@Astra check it too')
    await userEvent.click(screen.getByTestId('ticket-composer-send'))
    await waitFor(() => expect(calls('reviews.astraAsk')).toHaveLength(2))
    const asks = calls('reviews.astraAsk').map(
      ([, input]) => input as { agent: string; text: string },
    )
    expect(asks.map((a) => [a.agent, a.text])).toEqual([
      ['nova', '@Nova check the plan'],
      ['astra', '@Astra check it too'],
    ])
    expect(calls('tickets.prepare')).toHaveLength(0)
    expect(calls('tickets.commit')).toHaveLength(0)
  })

  it('a configured custom assistant, punctuation and formatting: private asks, nothing public', async () => {
    gate()
    configure([
      { id: 'astra', title: 'Astra' },
      { id: 'scout', title: 'Scout' },
    ])
    view(dataOf({ writeMode: 'legacy' }))
    const box = screen.getByTestId('ticket-composer') as HTMLTextAreaElement
    for (const text of ['(@Scout, check this)', '**@Astra** please check']) {
      await userEvent.type(box, text)
      expect(screen.getByTestId('composer-private').textContent).toContain('Only you')
      await userEvent.click(screen.getByTestId('ticket-composer-send'))
      await waitFor(() => expect(box.value).toBe(''))
    }
    const asks = calls('reviews.astraAsk').map(([, i]) => i as { agent: string; text: string })
    expect(asks.map((a) => [a.agent, a.text])).toEqual([
      ['scout', '(@Scout, check this)'],
      ['astra', '**@Astra** please check'],
    ])
    // Her own session was read, not Astra's under another name.
    expect(calls('reviews.astraThread').map(([, i]) => i)).toEqual(
      expect.arrayContaining([
        { url: detail.url, agent: 'astra' },
        { url: detail.url, agent: 'scout' },
      ]),
    )
    expect(calls('reviews.linearComment')).toHaveLength(0)
    expect(calls('tickets.prepare')).toHaveLength(0)
    expect(calls('tickets.commit')).toHaveLength(0)
  })

  it('a person and an assistant in one message goes private only, with the notice', async () => {
    gate()
    view(dataOf())
    const box = screen.getByTestId('ticket-composer') as HTMLTextAreaElement
    await userEvent.type(box, '@Pal Lee and (@Nova) see this')
    expect(screen.getByTestId('composer-private').textContent).toContain(
      'Write a separate comment for people.',
    )
    await userEvent.click(screen.getByTestId('ticket-composer-send'))
    await waitFor(() => expect(calls('reviews.astraAsk')).toHaveLength(1))
    expect(calls('reviews.astraAsk')[0]![1]).toMatchObject({ agent: 'nova' })
    expect(calls('tickets.prepare')).toHaveLength(0)
    expect(calls('tickets.commit')).toHaveLength(0)
    expect(calls('reviews.linearComment')).toHaveLength(0)
  })

  it('@Astra in a reply asks privately with the thread, and her reply shows in that thread', async () => {
    gate()
    view(dataOf())
    await userEvent.click(within(commentEl('theirs')).getByRole('button', { name: 'Reply' }))
    await userEvent.type(await screen.findByTestId('ticket-reply-box'), '@Astra is this right?')
    expect(screen.getByTestId('composer-private').textContent).toContain('Only you')
    await userEvent.click(screen.getByTestId('ticket-reply-box-send'))
    await waitFor(() => expect(calls('reviews.astraAsk')).toHaveLength(1))
    const { text, agent } = calls('reviews.astraAsk')[0]![1] as { text: string; agent: string }
    expect(agent).toBe('astra')
    expect(text).toMatch(
      /^\(In the thread theirs on "Their root"\)\n<thread>\n- Pal Lee: Their root\n<\/thread>\n@Astra is this right\?$/,
    )
    pushAstra({
      url: 'https://linear.app/issue/ENG-1',
      title: 'Astra · ENG-1',
      file: 'f.jsonl',
      turns: [
        { id: 'u', role: 'user', text, streaming: false, at: 10 },
        { id: 'a', role: 'assistant', text: 'Yes, it holds.', streaming: false, at: 11 },
      ],
      working: false,
      waiting: null,
      error: null,
    })
    const thread = screen
      .getAllByTestId('ticket-thread')
      .find((t) => t.dataset.rootId === 'theirs')!
    const reply = await within(thread).findByTestId('assistant-reply')
    expect(reply.dataset.agent).toBe('astra')
    // Isaac sees his words, not the thread they carried; her answer is in the thread.
    expect(within(reply).getByTestId('review-astra-question').textContent).toContain(
      '@Astra is this right?',
    )
    expect(within(reply).getByTestId('review-astra-question').textContent).not.toContain('<thread>')
    expect(within(reply).getByTestId('review-astra-answer').textContent).toContain('Yes, it holds.')
    expect(within(reply).queryByTestId('review-astra-use')).toBeNull()
    expect(calls('tickets.prepare')).toHaveLength(0)
  })

  it('inline threads sit on the description, not in the activity; text edited away is listed', async () => {
    gate()
    const inline = (id: string, quotedText: string, over: Partial<TicketComment> = {}) =>
      comment(id, 10, { documentContentId: 'doc-1', quotedText, body: `On ${quotedText}`, ...over })
    const d = {
      ...detail,
      documentContentId: 'doc-1',
      description: 'Save the draft first. Then save the draft again.',
      comments: [
        ...detail.comments,
        inline('inl-1', 'the draft', {
          anchor: { prefix: 'Savethedraftfirst.Thensave', suffix: 'again.' },
        }),
        inline('inl-gone', 'old words'),
        inline('inl-done', 'first', { resolvedAt: 20 }),
      ],
    } as TicketDetail
    const data = dataOf({ detail: d })
    render(
      <MantineProvider>
        <TicketDescription data={data} />
        <Activity data={data} focusCommentId={null} />
      </MantineProvider>,
    )
    const roots = () => screen.getAllByTestId('ticket-thread').map((t) => t.dataset.rootId)
    const removed = await screen.findByTestId('inline-removed')
    expect(removed.textContent).toContain('Comment on removed text')
    expect(
      within(removed)
        .getAllByTestId('ticket-thread')
        .map((t) => t.dataset.rootId),
    ).toEqual(['inl-gone'])
    // The removed one under the description, then the activity's own threads.
    expect(roots()).toEqual(['inl-gone', 'mine', 'theirs'])
    expect(screen.getByTestId('inline-resolved-toggle').textContent).toBe('Resolved (1)')
  })
})

describe('clippedWords', () => {
  it('says what the host left out of a bounded ticket page', () => {
    expect(clippedWords(undefined)).toBeNull()
    expect(clippedWords({ description: false, comments: 0 })).toBeNull()
    expect(clippedWords({ description: true, comments: 3 })).toBe(
      'Not shown here: the end of the description and 3 older comments. Open it in Linear for all of it.',
    )
    expect(clippedWords({ description: false, comments: 1 })).toBe(
      'Not shown here: 1 older comment. Open it in Linear for all of it.',
    )
  })
})
