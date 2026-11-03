import { describe, expect, it } from 'vitest'
import { reasonOf, toRows } from './linear-inbox'

const me = { id: 'me', name: 'Isaac Weber', displayName: 'iweber' }
const steve = { id: 's', name: 'Steve Arms', displayName: 'sarms' }
const issue = (key: string, type = 'started', mine: string[] = []) => ({
  identifier: key,
  title: `T ${key}`,
  url: `https://linear.app/x/issue/${key}`,
  state: { type },
  comments: { nodes: mine.map((createdAt) => ({ createdAt, user: { id: 'me' } })) },
})
const n = (type: string, at: string, opts: Record<string, unknown> = {}) => ({
  type,
  createdAt: at,
  readAt: null,
  archivedAt: null,
  actor: steve,
  issue: issue('ENG-1'),
  ...opts,
})

describe('linear inbox queue', () => {
  it('counts mentions, comments and replies as asks, never assignments or status changes', () => {
    expect(reasonOf('issueCommentMention')).toBe('mentioned you')
    expect(reasonOf('issueNewComment')).toBe('commented')
    expect(reasonOf('issueAssignedToYou')).toBeNull()
    expect(reasonOf('issueStatusChanged')).toBeNull()
    expect(reasonOf('issueCommentReaction')).toBeNull()
  })

  it('keeps tickets with an unanswered ask from someone else, one row each, newest first', () => {
    const rows = toRows({
      viewer: me,
      notifications: {
        nodes: [
          n('issueCommentMention', '2026-10-30T10:00:00Z', { readAt: '2026-10-30T11:00:00Z' }),
          n('issueNewComment', '2026-10-30T09:00:00Z'),
          n('issueAssignedToYou', '2026-10-30T15:00:00Z', { issue: issue('ENG-7') }),
          n('issueCommentMention', '2026-10-30T12:00:00Z', { actor: me, issue: issue('ENG-2') }),
          n('issueNewComment', '2026-10-30T12:00:00Z', {
            issue: issue('ENG-3'),
            archivedAt: '2026-10-30T13:00:00Z',
          }),
          n('issueNewComment', '2026-10-30T12:00:00Z', { issue: issue('ENG-4', 'completed') }),
          // He answered after Steve's comment: gone until the next ask.
          n('issueNewComment', '2026-10-30T12:00:00Z', {
            issue: issue('ENG-5', 'started', ['2026-10-30T12:30:00Z']),
          }),
          // He commented before the mention: still waiting on him.
          n('issueCommentMention', '2026-10-30T08:00:00Z', {
            issue: issue('ENG-6', 'started', ['2026-10-30T07:00:00Z']),
          }),
        ],
      },
    })
    expect(rows.map((r) => [r.key, r.reason, r.actor, r.unread])).toEqual([
      ['ENG-1', 'mentioned you', 'Steve Arms', true],
      ['ENG-6', 'mentioned you', 'Steve Arms', true],
    ])
    expect(rows[0]!.updatedAt).toBe(Date.parse('2026-10-30T10:00:00Z'))
  })
})
