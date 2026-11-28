import { describe, expect, it } from 'vitest'
import { cardOf, ticketOf, waitingFrom } from '../agents-board/test-cards'
import { setReviewTitle } from '../eva/names-store'
import {
  boardOrder,
  cardOfRef,
  cardPlace,
  parseTicketPlace,
  ticketPlace,
  ticketTabTitle,
  waitingPlace,
} from './ticket-place'

describe('ticket places', () => {
  it('prints and parses keys, work items, PRs and comment anchors', () => {
    const cases = [
      [ticketPlace('ENG-12'), 'ticket:ENG-12'],
      [ticketPlace('relay-demo', { item: true }), 'ticket:item/relay-demo'],
      [
        ticketPlace('ENG-12', { pr: { repo: 'acme/app', number: 7 } }),
        'ticket:ENG-12/pr/acme/app/7',
      ],
      [ticketPlace('ENG-12', { comment: 'c-1' }), 'ticket:ENG-12#comment-c-1'],
      [
        ticketPlace('relay-demo', { item: true, pr: { repo: 'a.b/c-d', number: 3 } }),
        'ticket:item/relay-demo/pr/a.b/c-d/3',
      ],
    ] as const
    for (const [place, page] of cases) {
      expect(place.page).toBe(page)
      const ref = parseTicketPlace(page)!
      expect(ticketPlace(ref.id, { item: ref.kind === 'item', ...ref }).page).toBe(page)
    }
    expect(parseTicketPlace('ticket:ENG-12/pr/acme/app/7')).toEqual({
      kind: 'key',
      id: 'ENG-12',
      pr: { repo: 'acme/app', number: 7 },
      comment: null,
    })
    expect(parseTicketPlace('ticket:ENG-12#comment-abc')?.comment).toBe('abc')
  })

  it('keeps same-number PRs in two repos apart', () => {
    const a = ticketPlace('ENG-1', { pr: { repo: 'acme/app', number: 5 } })
    const b = ticketPlace('ENG-1', { pr: { repo: 'acme/web', number: 5 } })
    expect(a.page).not.toBe(b.page)
    expect(parseTicketPlace(b.page)?.pr).toEqual({ repo: 'acme/web', number: 5 })
  })

  it('reads nothing it does not make', () => {
    for (const page of [
      'review:linear:ENG-1',
      'ticket:',
      'ticket:eng-1',
      'ticket:item/',
      'ticket:ENG-1/pr/acme/7',
    ]) {
      expect(parseTicketPlace(page)).toBeNull()
    }
  })

  it('opens a card at its page, a waiting mention at its comment or PR', () => {
    const ticket = cardOf({ key: 'ENG-1' })
    const item = cardOf({
      id: 'item:relay-demo',
      key: 'relay-demo',
      openTarget: { kind: 'item', id: 'relay-demo' },
    })
    const run = cardOf({
      openTarget: { kind: 'link', open: { kind: 'url', url: 'https://x.test' } } as never,
    })
    expect(cardPlace(ticket)?.page).toBe('ticket:ENG-1')
    expect(cardPlace(item)?.page).toBe('ticket:item/relay-demo')
    expect(cardPlace(run)).toBeNull()
    const w = waitingFrom('Chris', 'c-9')
    expect(waitingPlace(ticket, w)?.page).toBe('ticket:ENG-1#comment-c-9')
    const onPr = {
      ...w,
      anchor: {
        ...w.anchor,
        kind: 'pr-conversation' as const,
        pr: { repo: 'acme/app', number: 4 },
      },
    }
    expect(waitingPlace(ticket, onPr)?.page).toBe('ticket:ENG-1/pr/acme/app/4')
    expect(cardOfRef([run, item, ticket], parseTicketPlace('ticket:item/relay-demo')!)).toBe(item)
    expect(cardOfRef([run, item, ticket], parseTicketPlace('ticket:ENG-1')!)).toBe(ticket)
  })

  it('orders the board shown columns first, each top to bottom', () => {
    const c = (key: string, column: 'queued' | 'working' | 'done') =>
      cardOf({ key, column, ticket: ticketOf() })
    const cards = [c('A-1', 'done'), c('A-2', 'working'), c('A-3', 'queued'), c('A-4', 'working')]
    expect(boardOrder(cards, ['done']).map((x) => x.key)).toEqual(['A-3', 'A-2', 'A-4', 'A-1'])
  })

  it('names the tab like a review tab', () => {
    expect(ticketTabTitle('ticket:ENG-77')).toBe('ENG-77')
    setReviewTitle('linear:ENG-77', 'ENG-77 Fix the thing')
    expect(ticketTabTitle('ticket:ENG-77')).toBe('ENG-77 Fix the thing')
    expect(ticketTabTitle('ticket:ENG-77/pr/acme/app/3')).toBe('ENG-77 Fix the thing · PR #3')
    expect(ticketTabTitle('ticket:item/relay-demo')).toBe('relay-demo')
  })
})
