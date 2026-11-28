import { describe, expect, it } from 'vitest'
import type { TicketComment } from '@relay/protocol'
import {
  NO_EDITS,
  agentOf,
  assistantPeople,
  assistantsIn,
  commentActions,
  focusTarget,
  isEmojiOnly,
  issueTitleOf,
  mentionQuery,
  privacyOf,
  reactionKey,
  threadsOf,
  todoState,
  withLocal,
} from './activity-model'

const pal = { id: 'u-pal', name: 'Pal Lee', avatarUrl: null }
const me = { id: 'u-me', name: 'Isaac', avatarUrl: null }

const c = (
  id: string,
  at: number,
  parentId: string | null = null,
  over: Partial<TicketComment> = {},
) =>
  ({
    id,
    parentId,
    documentContentId: null,
    quotedText: null,
    author: pal,
    body: `body ${id}`,
    at,
    editedAt: null,
    resolvedAt: null,
    resolvingUser: null,
    reactions: [],
    url: `https://linear.app/x/issue/ENG-1#comment-${id}`,
    ...over,
  }) satisfies TicketComment

describe('threadsOf', () => {
  it('groups replies under their root, oldest first, whatever order they come in', () => {
    const threads = threadsOf([
      c('r2', 30),
      c('a1', 20, 'r1'),
      c('r1', 10),
      c('a2', 40, 'r1'),
      c('b1', 35, 'r2'),
    ])
    expect(threads.map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([
      ['r1', ['a1', 'a2']],
      ['r2', ['b1']],
    ])
  })

  it('a reply to a reply joins the root; an orphan stands as its own root', () => {
    const threads = threadsOf([c('r1', 1), c('a1', 2, 'r1'), c('a2', 3, 'a1'), c('o1', 4, 'gone')])
    expect(threads.map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([
      ['r1', ['a1', 'a2']],
      ['o1', []],
    ])
  })

  it('emoji-only replies are replies like any other', () => {
    const threads = threadsOf([
      c('r1', 1),
      c('a1', 2, 'r1', { body: '👍' }),
      c('a2', 3, 'r1', { body: ':tada:' }),
    ])
    expect(threads[0]!.replies.map((r) => r.id)).toEqual(['a1', 'a2'])
  })
})

describe('focusTarget', () => {
  const threads = threadsOf([c('r1', 1), c('a1', 2, 'r1'), c('r2', 3)])
  it('finds a root or a reply, with its thread', () => {
    expect(focusTarget(threads, 'r2')).toEqual({ rootId: 'r2', commentId: 'r2' })
    expect(focusTarget(threads, 'a1')).toEqual({ rootId: 'r1', commentId: 'a1' })
  })
  it('null for no anchor or one not on the page', () => {
    expect(focusTarget(threads, null)).toBeNull()
    expect(focusTarget(threads, 'nope')).toBeNull()
  })
})

describe('isEmojiOnly', () => {
  it.each(['👍', ' 🎉🎉 ', '👍🏽', '👨‍👩‍👧', '🇺🇸', ':+1:', ':tada: :rocket:', '❤️'])(
    '%s is emoji only',
    (t) => expect(isEmojiOnly(t)).toBe(true),
  )
  it.each(['ok 👍', '123', '', 'thanks', ':not_an_emoji_name:', '#'])('%s is not', (t) =>
    expect(isEmojiOnly(t)).toBe(false),
  )
})

describe('withLocal', () => {
  it('adds a posted comment until the host has it, once', () => {
    const posted = c('new', 9, null, { author: me })
    const local = { ...NO_EDITS, posted: [posted] }
    expect(withLocal([c('r1', 1)], local, me, 10).map((x) => x.id)).toEqual(['r1', 'new'])
    expect(withLocal([c('r1', 1), posted], local, me, 10).map((x) => x.id)).toEqual(['r1', 'new'])
  })

  it('a deleted root takes its replies; edits, resolves and reactions apply', () => {
    const comments = [
      c('r1', 1),
      c('a1', 2, 'r1'),
      c('r2', 3, null, { reactions: [{ emoji: '+1', users: [pal] }] }),
    ]
    const local = {
      ...NO_EDITS,
      deleted: ['r1'],
      edited: { r2: 'new text' },
      resolved: { r2: true },
      reacted: { [reactionKey('r2', '+1')]: true, [reactionKey('r2', 'tada')]: true },
    }
    const [r2] = withLocal(comments, local, me, 50)
    expect(r2!.id).toBe('r2')
    expect(r2!.body).toBe('new text')
    expect(r2!.editedAt).toBe(50)
    expect(r2!.resolvedAt).toBe(50)
    expect(r2!.reactions).toEqual([
      { emoji: '+1', users: [pal, me] },
      { emoji: 'tada', users: [me] },
    ])
    const off = withLocal(
      comments,
      { ...NO_EDITS, reacted: { [reactionKey('r2', '+1')]: false } },
      pal,
      50,
    )
    expect(off[2]!.reactions).toEqual([])
  })
})

describe('commentActions', () => {
  const mine = c('m', 1, null, { author: me })
  const theirs = c('t', 1)
  it('Isaac’s own root through the gate: everything', () => {
    expect(commentActions(mine, { meId: 'u-me', isRoot: true, writeMode: 'gate' })).toEqual([
      'edit',
      'resolve',
      'copyLink',
      'copyMarkdown',
      'newIssue',
      'delete',
    ])
  })
  it('someone else’s reply: no edit, delete or resolve', () => {
    expect(commentActions(theirs, { meId: 'u-me', isRoot: false, writeMode: 'gate' })).toEqual([
      'copyLink',
      'copyMarkdown',
      'newIssue',
    ])
  })
  it('a resolved root offers Unresolve', () => {
    const resolved = { ...theirs, resolvedAt: 5 }
    expect(commentActions(resolved, { meId: 'u-me', isRoot: true, writeMode: 'gate' })).toContain(
      'unresolve',
    )
  })
  it('without the gate only the copies', () => {
    for (const writeMode of ['legacy', 'none'] as const)
      expect(commentActions(mine, { meId: 'u-me', isRoot: true, writeMode })).toEqual([
        'copyLink',
        'copyMarkdown',
      ])
  })
})

describe('privacyOf', () => {
  const people = [{ name: 'Pal Lee', handle: 'pal', url: '' }]
  it('an assistant makes it private; with a person too it is mixed', () => {
    expect(privacyOf('@Astra what next?', people)).toBe('private')
    expect(privacyOf('@polaris and @Nova', people)).toBe('private')
    expect(privacyOf('@Pal Lee and @Astra', people)).toBe('mixed')
    expect(privacyOf('@Pal Lee see this', people)).toBe('public')
    expect(privacyOf('email astra@example.com', people)).toBe('public')
  })
  it('names the assistants mentioned', () => {
    expect(assistantsIn('@Penny @Iris hi').map((a) => a.name)).toEqual(['Penny', 'Iris'])
  })
  it('reads a mention where the composer does: after punctuation and formatting, not in an address', () => {
    expect(privacyOf('(@Astra, check this)', people)).toBe('private')
    expect(privacyOf('**@Astra** please check', people)).toBe('private')
    expect(privacyOf('_@astra_: look', people)).toBe('private')
    expect(privacyOf('Thanks @Astra.', people)).toBe('private')
    expect(privacyOf('[@Pal Lee] and (@Nova)', people)).toBe('mixed')
    expect(privacyOf('**@Pal Lee** see this', people)).toBe('public')
    expect(privacyOf('mail astra@example.com or @@Astra', people)).toBe('public')
    expect(privacyOf('@Astral is a word, @Astra-bot a name, @Astra.io a host', people)).toBe(
      'public',
    )
    expect(mentionQuery('ask (@As')).toBe('As')
    expect(mentionQuery('**@')).toBe('')
    expect(mentionQuery('astra@ex')).toBeNull()
  })
  it('resolves assistants from the configured registry, ids and one-word titles alike', () => {
    const registry = assistantPeople([
      { id: 'astra', title: 'Astra' },
      { id: 'scout', title: 'Scout' },
      { id: 'code-review', title: 'Code Review' },
    ])
    expect(registry.map((a) => [a.handle, agentOf(a)])).toEqual([
      ['Astra', 'astra'],
      ['Scout', 'scout'],
      ['code-review', 'code-review'],
      ['Nova', 'nova'],
      ['Penny', 'penny'],
      ['Iris', 'iris'],
      ['Polaris', 'polaris'],
    ])
    expect(privacyOf('**@Scout** dig into this', people, registry)).toBe('private')
    expect(privacyOf('@Pal Lee, @code-review: thoughts?', people, registry)).toBe('mixed')
    expect(privacyOf('@Code Review thoughts?', people, registry)).toBe('private')
    expect(assistantsIn('(@scout, @Astra)', registry).map(agentOf)).toEqual(['astra', 'scout'])
    expect(privacyOf('@Scout check', people, assistantPeople(null))).toBe('public')
    // An empty or unloaded registry (a thin client's) never makes a built-in one public.
    expect(privacyOf('@Nova check', people, assistantPeople([]))).toBe('private')
    expect(privacyOf('@Astra check', people, assistantPeople(null))).toBe('private')
  })
})

describe('new issue helpers', () => {
  it('Todo by exact name, else none', () => {
    expect(
      todoState([
        { id: 'a', name: 'Backlog' },
        { id: 'b', name: 'Todo' },
      ])?.id,
    ).toBe('b')
    expect(todoState([{ id: 'a', name: 'todo' }])).toBeNull()
    expect(
      todoState([
        { id: 'a', name: 'Todo' },
        { id: 'b', name: 'Todo' },
      ]),
    ).toBeNull()
  })
  it('title from the first line', () => {
    expect(issueTitleOf('\n> Fix the **export** rerun\nmore')).toBe('Fix the **export** rerun')
  })
})
