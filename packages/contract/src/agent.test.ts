import { describe, expect, it } from 'vitest'
import {
  AGENT_ACTION_IDS,
  AgentResultSchema,
  agentActions,
  agentCatalog,
  isAgentActionId,
  type AgentActionSpec,
} from './agent'
import { EVENT_CHANNELS, INVOKE_CHANNELS } from './index'

describe('agent action registry', () => {
  it('names every action <area>[.<part>].<verb> with a title, description and side', () => {
    for (const id of AGENT_ACTION_IDS) {
      expect(id).toMatch(/^[a-z]+(?:\.[a-z]+)?\.[a-zA-Z]+$/)
      const a = agentActions[id]
      expect(a.title.length).toBeGreaterThan(0)
      expect(a.description.length).toBeGreaterThan(0)
      expect(['main', 'renderer']).toContain(a.side)
    }
  })

  it('serves every params schema as JSON Schema', () => {
    const catalog = agentCatalog()
    expect(catalog.map((c) => c.id)).toEqual(AGENT_ACTION_IDS)
    for (const c of catalog) expect(c.params).toMatchObject({ type: 'object' })
    const files = catalog.find((c) => c.id === 'files.open')!
    expect(files.params).toMatchObject({ required: ['path'], additionalProperties: false })
  })

  it('marks quitting and sending as Isaac destructive, nothing else', () => {
    const destructive = AGENT_ACTION_IDS.filter((id) => agentActions[id].destructive)
    expect(destructive.sort()).toEqual(['app.quit', 'chat.start'])
  })

  it('says what each action replaces, so it can wait while Isaac types there', () => {
    const main = AGENT_ACTION_IDS.filter((id) => agentActions[id].focus === 'main')
    expect(main).toEqual(
      expect.arrayContaining(['page.open', 'chat.open', 'chat.new', 'testbench.open', 'tab.focus']),
    )
    for (const id of [
      'files.open',
      'browser.open',
      'tab.open',
      'pane.split',
      'pane.close',
    ] as const) {
      expect(agentActions[id].focus).toBe('panel')
    }
    for (const id of ['state.read', 'layout.read', 'window.screenshot', 'toast.show'] as const) {
      expect(agentActions[id].focus).toBe('none')
    }
  })

  it('lays out panes without the caller scope, and checks tab specs', () => {
    const layout = AGENT_ACTION_IDS.filter((id) => id.startsWith('pane.'))
    expect(layout.sort()).toEqual([
      'pane.close',
      'pane.focus',
      'pane.move',
      'pane.resize',
      'pane.split',
      'pane.zoom',
    ])
    for (const id of layout) {
      const spec: AgentActionSpec = agentActions[id]
      expect(spec.unscoped).toBe(true)
    }
    const openSpec: AgentActionSpec = agentActions['tab.open']
    expect(openSpec.unscoped).toBeUndefined()
    const open = agentActions['tab.open'].params
    expect(open.safeParse({ kind: 'files', args: { path: 'a.ts', line: 3 } }).success).toBe(true)
    expect(open.safeParse({ kind: 'browser', pane: 'p2', scope: 'agent:nova' }).success).toBe(true)
    expect(open.safeParse({ kind: 'page', args: { page: 'test-bench' } }).success).toBe(true)
    expect(open.safeParse({ kind: 'page', args: { page: 'chat' } }).success).toBe(false)
    expect(open.safeParse({ kind: 'terminal' }).success).toBe(false)
    expect(open.safeParse({ kind: 'subagent', args: { name: 'x' } }).success).toBe(false)
    const split = agentActions['pane.split'].params
    expect(split.safeParse({ dir: 'down', tab: 'browser' }).success).toBe(true)
    expect(split.safeParse({ dir: 'down', tab: { kind: 'artifacts' }, size: 0.3 }).success).toBe(
      true,
    )
    expect(split.safeParse({ dir: 'down', size: 1 }).success).toBe(false)
    expect(split.safeParse({ dir: 'down', scope: 'x' }).success).toBe(false)
    const resize = agentActions['pane.resize'].params
    expect(resize.safeParse({ pane: 'p2', size: 0.4 }).success).toBe(true)
    expect(resize.safeParse({ pane: 'p2', px: 400 }).success).toBe(true)
    expect(resize.safeParse({ pane: 'p2' }).success).toBe(false)
    expect(resize.safeParse({ pane: 'p2', size: 0.4, px: 400 }).success).toBe(false)
    expect(agentActions['pane.focus'].params.safeParse({ dir: 'left' }).success).toBe(true)
    expect(agentActions['tab.close'].params.safeParse({ id: 3 }).success).toBe(true)
    expect(agentActions['tab.close'].params.safeParse({ id: 'files' }).success).toBe(true)
  })

  it('validates params', () => {
    const page = agentActions['page.open'].params
    expect(page.safeParse({ page: 'test-bench' }).success).toBe(true)
    expect(page.safeParse({ page: 'workspace:ecard' }).success).toBe(true)
    expect(page.safeParse({ page: 'nope' }).success).toBe(false)
    expect(page.safeParse({ page: 'jobs', extra: 1 }).success).toBe(false)

    const files = agentActions['files.open'].params
    expect(files.safeParse({ path: '.omp/skills' }).success).toBe(true)
    expect(files.safeParse({ path: 'a.ts', line: 0 }).success).toBe(false)
    expect(files.safeParse({}).success).toBe(false)

    const bench = agentActions['testbench.open'].params
    expect(bench.safeParse({ experiment: 'x', arm: 'a' }).success).toBe(true)
    expect(bench.safeParse({ arm: 'a' }).success).toBe(false)

    expect(agentActions['browser.focusTab'].params.safeParse({ tabId: 'nope' }).success).toBe(false)
    expect(agentActions['shortcut.run'].params.safeParse({ action: 'focus-search' }).success).toBe(
      false,
    )
  })

  it('update.offer runs in main without confirm or focus and validates summary and build', () => {
    const spec = agentActions['update.offer']
    expect(spec.side).toBe('main')
    expect(spec.focus).toBe('none')
    expect(spec.destructive).toBe(false)
    const p = spec.params
    expect(p.safeParse({ summary: 'Faster list', build: 'abc1234' }).success).toBe(true)
    expect(p.safeParse({ summary: '', build: 'abc' }).success).toBe(false)
    expect(p.safeParse({ summary: 'x'.repeat(201), build: 'abc' }).success).toBe(false)
    expect(p.safeParse({ summary: 'ok', build: '' }).success).toBe(false)
    expect(p.safeParse({ summary: 'ok', build: 'x'.repeat(65) }).success).toBe(false)
    expect(p.safeParse({ summary: 'ok', build: 'abc', extra: 1 }).success).toBe(false)
    expect(agentCatalog().find((c) => c.id === 'update.offer')).toMatchObject({ side: 'main' })
  })

  it('recognizes ids without trusting prototype keys', () => {
    expect(isAgentActionId('files.open')).toBe(true)
    expect(isAgentActionId('toString')).toBe(false)
    expect(isAgentActionId('__proto__')).toBe(false)
  })

  it('carries results and the bridge channels', () => {
    expect(AgentResultSchema.safeParse({ ok: true, value: 1, queued: true }).success).toBe(true)
    expect(AgentResultSchema.safeParse({ ok: false, code: 'denied', message: 'no' }).success).toBe(
      true,
    )
    expect(INVOKE_CHANNELS).toEqual(expect.arrayContaining(['agent.reply', 'agent.confirm.reply']))
    expect(EVENT_CHANNELS).toEqual(expect.arrayContaining(['agent.run', 'agent.confirm']))
  })
})

describe('artifacts actions', () => {
  it('take the caller scope, run in main, and check their params', () => {
    const ids = AGENT_ACTION_IDS.filter((id) => id.startsWith('artifacts.'))
    expect(ids).toEqual([
      'artifacts.list',
      'artifacts.add',
      'artifacts.pin',
      'artifacts.unpin',
      'artifacts.tab.add',
      'artifacts.tab.update',
      'artifacts.tab.remove',
    ])
    for (const id of ids) {
      const spec: AgentActionSpec = agentActions[id]
      expect(spec.side).toBe('main')
      expect(spec.scoped).toBe(true)
      expect(spec.description).not.toMatch(/\u2014/)
    }
    expect(agentActions['artifacts.tab.add'].description).toMatch(/default tabs first/)
    const add = agentActions['artifacts.tab.add'].params
    expect(
      add.safeParse({
        title: 'Open PRs',
        icon: 'git-pull-request',
        rule: { kind: ['gh-pr'], state: ['open'] },
      }).success,
    ).toBe(true)
    expect(add.safeParse({ title: 'x', rule: { kind: ['nope'] } }).success).toBe(false)
    expect(
      agentActions['artifacts.pin'].params.safeParse({ id: 'linear:ENG-1', scope: 'agent:astra' })
        .success,
    ).toBe(true)
    expect(
      agentActions['artifacts.tab.update'].params.safeParse({ id: 'open-prs', hidden: true })
        .success,
    ).toBe(false)
    expect(agentActions['tab.open'].params.safeParse({ kind: 'artifacts' }).success).toBe(true)
  })
})
