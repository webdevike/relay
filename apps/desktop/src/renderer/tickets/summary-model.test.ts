import { describe, expect, it } from 'vitest'
import type { TicketComment, TicketDetail } from '@relay/protocol'
import { cardOf, ticketOf, waitingFrom } from '../agents-board/test-cards'
import { attentionLines, commentsSince, footerPrs, footerText } from './summary-model'

const H = 3_600_000
const NOW = Date.parse('2026-11-27T12:00:00Z')
const pal = { id: 'user-pal', name: 'Sample Teammate', avatarUrl: null }
const me = { id: 'user-me', name: 'Isaac', avatarUrl: null }

const comment = (id: string, at: number, author = pal): TicketComment => ({
  id,
  parentId: null,
  documentContentId: null,
  quotedText: null,
  author,
  body: 'text',
  at,
  editedAt: null,
  resolvedAt: null,
  resolvingUser: null,
  reactions: [],
  url: `https://linear.example.test/c/${id}`,
})

const detailOf = (over: Partial<TicketDetail> = {}): TicketDetail =>
  ({
    key: 'ENG-1',
    updatedAt: NOW - 2 * H,
    prFacts: [],
    comments: [],
    attention: { waiting: [], needsYou: null },
    ...over,
  }) as TicketDetail

const waitingMention = {
  provider: 'linear' as const,
  itemId: 'ENG-1',
  rootId: 'c-2',
  commentId: 'c-2',
  author: pal,
  at: NOW - H,
  excerpt: 'Can you look?',
  count: 1,
  anchor: { kind: 'comment' as const },
}
const needsWaiting = {
  kind: 'waiting' as const,
  text: 'Sample Teammate asked you a question',
  action: { kind: 'reply' as const, label: 'Reply' },
  evidence: 'c-2',
}
const needsMerge = {
  kind: 'merge' as const,
  text: 'Merge PR #12. It is approved and checks pass.',
  action: { kind: 'openPr' as const, label: 'Open PR #12', pr: { repo: 'acme/app', number: 12 } },
  evidence: 'sha:APPROVED',
}

describe('commentsSince', () => {
  it('counts against the watermark kept for the visit across two visits', () => {
    // Visit 1 sees two comments; seen returns null (first visit).
    const visit1 = [comment('c-1', NOW - 5 * H), comment('c-2', NOW - 4 * H)]
    expect(commentsSince(visit1, null, me.id)).toBeNull()
    const watermark = NOW - 3 * H // stamped when visit 1 opened
    // Between visits: two from others and one of Isaac's own.
    const visit2 = [
      ...visit1,
      comment('c-3', NOW - 2 * H),
      comment('c-4', NOW - H, me),
      comment('c-5', NOW - H / 2),
    ]
    expect(commentsSince(visit2, watermark, me.id)).toBe(2)
    // A new comment arriving during visit 2 still counts against the same kept watermark.
    expect(commentsSince([...visit2, comment('c-6', NOW)], watermark, me.id)).toBe(3)
  })
})

describe('footerText', () => {
  const comments = [comment('c-1', NOW - 5 * H), comment('c-2', NOW - H)]
  it('says comments since you last looked when some are new', () => {
    expect(
      footerText({
        updatedAt: NOW - 2 * H,
        now: NOW,
        comments,
        previousSeenAt: NOW - 3 * H,
        meId: me.id,
      }),
    ).toEqual(['Updated 2h ago', '1 comment since you last looked'])
  })
  it('falls back to the total on a first visit or when nothing is new', () => {
    const base = { updatedAt: NOW - 2 * H, now: NOW, comments, meId: me.id }
    expect(footerText({ ...base, previousSeenAt: null })).toEqual(['Updated 2h ago', '2 comments'])
    expect(footerText({ ...base, previousSeenAt: NOW })).toEqual(['Updated 2h ago', '2 comments'])
  })
  it('says just now and leaves comments out when there are none', () => {
    expect(
      footerText({ updatedAt: NOW, now: NOW, comments: [], previousSeenAt: null, meId: null }),
    ).toEqual(['Updated just now'])
    expect(
      footerText({ updatedAt: null, now: NOW, comments: [], previousSeenAt: null, meId: null }),
    ).toEqual([])
  })
})

describe('footerPrs', () => {
  it('labels draft PRs from the page facts, else from the card', () => {
    const fact = { repo: 'acme/app', number: 269, state: 'open', draft: true }
    const detail = detailOf({ prFacts: [fact] as TicketDetail['prFacts'] })
    expect(footerPrs(detail, null).map((p) => p.label)).toEqual(['PR #269 draft'])
    const card = cardOf({
      key: 'ENG-1',
      ticket: ticketOf({
        prs: [
          {
            repo: 'acme/app',
            number: 7,
            url: 'u',
            title: 't',
            state: 'merged',
            checks: 'pass',
            decision: null,
          },
        ],
      }),
    })
    expect(footerPrs(detailOf(), card).map((p) => p.label)).toEqual(['PR #7 merged'])
  })
})

describe('attentionLines', () => {
  it('shows the waiting line alone when Needs you only repeats it', () => {
    const detail = detailOf({ attention: { waiting: [waitingMention], needsYou: needsWaiting } })
    const a = attentionLines(detail, null)
    expect(a.waiting?.commentId).toBe('c-2')
    expect(a.needs).toBeNull()
  })
  it('keeps both when Needs you asks something else', () => {
    const detail = detailOf({ attention: { waiting: [waitingMention], needsYou: needsMerge } })
    const a = attentionLines(detail, null)
    expect(a.waiting?.commentId).toBe('c-2')
    expect(a.needs?.action.pr).toEqual({ repo: 'acme/app', number: 12 })
  })
  it('shows a waiting-kind Needs you when nothing waits', () => {
    const detail = detailOf({ attention: { waiting: [], needsYou: needsWaiting } })
    expect(attentionLines(detail, null).needs?.kind).toBe('waiting')
  })
  it('uses the newest mention, and the card when the page has no attention', () => {
    const older = { ...waitingMention, commentId: 'c-1', at: NOW - 3 * H }
    const detail = detailOf({ attention: { waiting: [older, waitingMention], needsYou: null } })
    expect(attentionLines(detail, null).waiting?.commentId).toBe('c-2')
    const card = cardOf({
      key: 'ENG-1',
      ticket: ticketOf({ waiting: waitingFrom('Chris Doe', 'c-9'), needsYou: null }),
    })
    expect(attentionLines(detailOf(), card).waiting?.commentId).toBe('c-9')
  })
})
