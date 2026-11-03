import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_DONE_MS,
  ARTIFACT_STALE_MS,
  Artifact,
  ArtifactAction,
  ArtifactTabIcon,
  DAY_MS,
  TabRule,
  artifactFaded,
  defaultTabFor,
  defaultTabs,
  isDefaultTab,
  ruleMatches,
  sameRule,
  subagentView,
  tabItems,
  tidyIds,
  visibleTabs,
  type ArtifactTab,
} from './artifacts'

const NOW = new Date(2026, 9, 27, 15, 0).getTime()

const item = (id: string, extra: Partial<Artifact> = {}): Artifact => ({
  id,
  kind: (id.split(':')[0] as Artifact['kind']) ?? 'url',
  title: id,
  mentions: 1,
  firstSeen: NOW - 1000,
  lastSeen: NOW - 1000,
  sources: [],
  addedBy: 'extractor',
  ...extra,
})

describe('tab icons', () => {
  it('reads the old robot icon as subtask and gives Subagents the subtask icon', () => {
    expect(ArtifactTabIcon.parse('robot')).toBe('subtask')
    expect(ArtifactTabIcon.parse('subtask')).toBe('subtask')
    expect(ArtifactTabIcon.safeParse('owl').success).toBe(false)
    expect(defaultTabs().find((t) => t.id === 'subagents')?.icon).toBe('subtask')
  })
})

describe('artifacts mirror', () => {
  it('starts with the four default tabs, in order, none hidden', () => {
    const tabs = defaultTabs()
    expect(tabs.map((t) => t.id)).toEqual(['subagents', 'links', 'media', 'everything'])
    expect(tabs.every((t) => !t.hidden && t.createdBy === 'default')).toBe(true)
    expect(isDefaultTab('links')).toBe(true)
    expect(isDefaultTab('open-prs')).toBe(false)
  })

  it('compares rules by meaning and names the default a rule repeats', () => {
    expect(
      sameRule(
        { kind: ['url', 'linear'], state: ['Open'] },
        { kind: ['linear', 'url'], state: ['open '] },
      ),
    ).toBe(true)
    expect(defaultTabFor({ kind: ['branch', 'url', 'gh-issue', 'gh-pr', 'linear'] })).toBe('links')
    expect(defaultTabFor({})).toBe('everything')
    expect(defaultTabFor({ kind: ['gh-pr'], state: ['open'] })).toBeNull()
  })

  it('matches rules field by field: kind, state or category, repo by name, caption either part', () => {
    const pr = item('gh-pr:eCardSystems/reports#238', {
      repo: 'eCardSystems/reports',
      status: { state: 'open', fetchedAt: NOW },
    })
    expect(ruleMatches({ kind: ['gh-pr'], state: ['OPEN'] }, pr)).toBe(true)
    expect(ruleMatches({ kind: ['gh-pr'], state: ['merged'] }, pr)).toBe(false)
    expect(ruleMatches({ repo: 'reports' }, pr)).toBe(true)
    expect(ruleMatches({ repo: 'ports' }, pr)).toBe(false)
    const ticket = item('linear:ENG-1', {
      status: { state: 'in qa', stateType: 'started', fetchedAt: NOW },
    })
    expect(ruleMatches({ state: ['started'] }, ticket)).toBe(true)
    const shot = item('drop:a', { caption: 'Before the fix', media: { mimeType: 'image/png' } })
    expect(ruleMatches({ media: true, caption: 'after|before' }, shot)).toBe(true)
    expect(ruleMatches({ media: false }, shot)).toBe(false)
    expect(ruleMatches({ pinned: true }, shot)).toBe(false)
    expect(ruleMatches({ since: NOW }, shot)).toBe(false)
  })

  it('fades stale items, finished work after two days, finished subagents the next day; never pins', () => {
    expect(artifactFaded(item('url:a', { lastSeen: NOW - ARTIFACT_STALE_MS - 1 }), NOW)).toBe(true)
    expect(
      artifactFaded(
        item('url:a', { lastSeen: NOW - ARTIFACT_STALE_MS - 1, pinned: { by: 'isaac', at: 1 } }),
        NOW,
      ),
    ).toBe(false)
    const merged = (changedAt: number) =>
      item('gh-pr:o/r#1', { status: { state: 'merged', fetchedAt: NOW, changedAt } })
    expect(artifactFaded(merged(NOW - ARTIFACT_DONE_MS - 1), NOW)).toBe(true)
    expect(artifactFaded(merged(NOW - ARTIFACT_DONE_MS + 1), NOW)).toBe(false)
    const sub = (state: 'running' | 'done', endedAt: number) =>
      item('subagent:/t.jsonl', { subagent: { state, startedAt: 0, endedAt } })
    expect(artifactFaded(sub('done', NOW - 60_000), NOW)).toBe(false)
    expect(artifactFaded(sub('done', NOW - DAY_MS), NOW)).toBe(true)
    expect(artifactFaded(sub('running', NOW - 2 * DAY_MS), NOW)).toBe(false)
  })

  it('draws a rule tab pinned first, then running subagents, then latest; an item tab in its order', () => {
    const items = [
      item('url:old', { lastSeen: NOW - 5000 }),
      item('url:new', { lastSeen: NOW - 10 }),
      item('url:pinned', { lastSeen: NOW - 9000, pinned: { by: 'nova', at: 5 } }),
      item('url:gone', { lastSeen: NOW - ARTIFACT_STALE_MS - 1 }),
    ]
    const everything = defaultTabs().find((t) => t.id === 'everything')!
    expect(tabItems(everything, items, NOW).map((i) => i.id)).toEqual([
      'url:pinned',
      'url:new',
      'url:old',
    ])
    const picked: ArtifactTab = {
      id: 'mine',
      title: 'Mine',
      createdBy: 'nova',
      createdAt: 0,
      hidden: false,
      items: ['url:gone', 'url:old', 'url:missing', 'url:pinned'],
    }
    expect(tabItems(picked, items, NOW).map((i) => i.id)).toEqual([
      'url:pinned',
      'url:gone',
      'url:old',
    ])
    expect(visibleTabs([{ ...picked, hidden: true }, everything]).map((t) => t.id)).toEqual([
      'everything',
    ])
  })

  it('parses actions and refuses unknown rule fields', () => {
    expect(
      ArtifactAction.safeParse({
        op: 'tab.add',
        title: 'Open PRs',
        rule: { kind: ['gh-pr'], state: ['open'] },
      }).success,
    ).toBe(true)
    expect(ArtifactAction.safeParse({ op: 'tab.update', tab: 'x', fresh: true }).success).toBe(
      false,
    )
    expect(
      ArtifactAction.safeParse({
        op: 'status',
        statuses: { 'linear:ENG-1': { state: 'done', title: 'A ticket', fetchedAt: 1 } },
      }).success,
    ).toBe(true)
    expect(TabRule.safeParse({ kind: ['gh-pr'], colour: 'red' }).success).toBe(false)
  })
})

describe('subagentView and tidyIds', () => {
  const sub = (id: string, state: 'running' | 'done' | 'failed', extra: Partial<Artifact> = {}) =>
    item(`subagent:${id}`, { subagent: { state, startedAt: NOW - 60_000 }, ...extra })

  it('reads a running subagent nobody touched in 30 minutes as done', () => {
    expect(subagentView(sub('a', 'running'), NOW)).toBe('running')
    const quiet = NOW - 31 * 60_000
    expect(
      subagentView(
        sub('a', 'running', { lastSeen: quiet, subagent: { state: 'running', startedAt: quiet } }),
        NOW,
      ),
    ).toBe('done')
    expect(subagentView(sub('a', 'failed'), NOW)).toBe('failed')
    expect(subagentView(item('linear:ENG-1'), NOW)).toBeNull()
  })

  it('tidies finished, closed, stale and duplicate items and keeps running, pinned and recent ones', () => {
    const fillers = [10, 20, 30, 40, 50].map((n) => `user@${NOW - 1000 + n}`)
    const all = [
      sub('run', 'running'),
      sub('done', 'done'),
      sub('bad', 'failed'),
      sub('pinned', 'done', { pinned: { by: 'isaac', at: NOW }, sources: fillers }),
      sub('fresh', 'done', { sources: [`assistant@${NOW}`] }),
      item('linear:ENG-9', {
        sources: ['user@1'],
        status: { state: 'done', stateType: 'completed', fetchedAt: NOW },
      }),
      item('linear:ENG-2', {
        sources: [`user@${NOW}`],
        status: { state: 'in progress', stateType: 'started', fetchedAt: NOW },
      }),
      item('url:https://a.test/x', {
        url: 'https://a.test/x',
        lastSeen: NOW - 2 * DAY_MS,
        sources: [`user@${NOW}`, 'user@1'],
      }),
      item('url:https://a.test/y', {
        url: 'https://a.test/y',
        lastSeen: NOW - 2 * DAY_MS,
        sources: ['user@2'],
      }),
      item('url:https://a.test/x#frag', {
        url: 'https://a.test/x#frag',
        lastSeen: NOW - 3 * DAY_MS,
        sources: ['user@3'],
      }),
    ]
    expect(tidyIds(all, NOW).sort()).toEqual([
      'linear:ENG-9',
      'subagent:bad',
      'subagent:done',
      'url:https://a.test/x#frag',
      'url:https://a.test/y',
    ])
  })

  it('does not offer an item that is already tidied', () => {
    expect(tidyIds([sub('done', 'done', { tidied: { by: 'isaac', at: NOW } })], NOW)).toEqual([])
  })
})
