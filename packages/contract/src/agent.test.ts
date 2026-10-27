import { describe, expect, it } from 'vitest'
import {
  AGENT_ACTION_IDS,
  AgentResultSchema,
  agentActions,
  agentCatalog,
  isAgentActionId,
} from './agent'
import { EVENT_CHANNELS, INVOKE_CHANNELS } from './index'

describe('agent action registry', () => {
  it('names every action <area>.<verb> with a title, description and side', () => {
    for (const id of AGENT_ACTION_IDS) {
      expect(id).toMatch(/^[a-z]+\.[a-zA-Z]+$/)
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

  it('queues every action that replaces the main column while Isaac types', () => {
    const main = AGENT_ACTION_IDS.filter((id) => agentActions[id].focus === 'main')
    expect(main).toEqual(
      expect.arrayContaining(['page.open', 'chat.open', 'chat.new', 'testbench.open', 'tab.focus']),
    )
    for (const id of ['files.open', 'browser.open', 'state.read', 'window.screenshot'] as const) {
      expect(agentActions[id].focus).toBe('none')
    }
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
