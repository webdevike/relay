import type { AgentCard } from '@evaos/contract'
import type { CardTicket, CardWaiting } from './board-view'

// Board cards for the renderer's unit tests.

export const NOW = Date.parse('2026-11-09T12:00:00Z')

export const ticketOf = (over: Partial<CardTicket> = {}): CardTicket => ({
  id: 'issue-1',
  state: { id: 's-1', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
  team: { id: 'team-eng', key: 'ENG' },
  priority: 2,
  project: null,
  milestone: null,
  labels: [],
  parent: null,
  sub: null,
  assignee: null,
  createdAt: Date.parse('2026-11-01T09:00:00Z'),
  updatedAt: NOW,
  prs: [],
  waiting: null,
  needsYou: null,
  ...over,
})

export const waitingFrom = (name: string, commentId = 'c-1'): CardWaiting => ({
  provider: 'linear',
  itemId: 'ENG-1',
  rootId: commentId,
  commentId,
  author: { name, avatarUrl: null },
  at: NOW - 3_600_000,
  excerpt: 'Can you check this?',
  count: 1,
  anchor: { kind: 'comment', pr: null, path: null, line: null, side: null },
})

export const cardOf = (over: Partial<AgentCard>): AgentCard => ({
  id: over.key ? `item:${over.key}` : 'run:x',
  kind: 'item',
  key: null,
  title: 'A card',
  column: 'queued',
  pill: { label: 'Queued', tone: 'default' },
  reason: '',
  workspace: null,
  agent: null,
  session: null,
  intent: null,
  stage: null,
  move: null,
  next: null,
  phase: null,
  pr: null,
  linear: null,
  activityAt: null,
  stale: false,
  links: [],
  ticket: null,
  openTarget: over.key ? { kind: 'ticket', key: over.key } : { kind: 'item', id: 'x' },
  dragBlock: null,
  ...over,
})
