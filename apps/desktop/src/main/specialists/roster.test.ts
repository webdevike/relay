import { describe, expect, it } from 'vitest'
import { SpecialistAgentsSchema } from '@evaos/contract'
import { agentFolderOf, rosterOf } from './roster'

const DOMAINS = '/home/app/atomic-agents/domains'
const ALLOWED = [DOMAINS, '/home/agents']

describe('rosterOf', () => {
  it('reads `list --json` into the page rows and each agent its files', () => {
    const list = [
      {
        id: 'diagram',
        purpose: 'Draw it.',
        kind: 'spec',
        file: `${DOMAINS}/diagram/agents/diagram/AGENT.md`,
        knowledge: [],
        enabled: true,
        model: 'anthropic/claude-sonnet-5-5',
        candidates: ['anthropic/claude-sonnet-5-5'],
        thinking: 'medium',
        how: 'ask',
        job: 'draw',
        runs: { week: 8, failed: 1, running: 1, lastAt: '2026-11-17T10:00:00.000Z' },
      },
      {
        id: 'ecard-slack-triage',
        purpose: 'Triage.',
        kind: 'spec',
        file: `${DOMAINS}/ecard/ecard-slack-triage.json`,
        knowledge: ['/Users/ike/Eva/references/slack-voice.md'],
        enabled: false,
        mode: 'shadow',
        model: 'anthropic/claude-haiku-5-5',
        fallbackModel: 'anthropic/claude-sonnet-5-5',
        candidates: [],
        runs: { week: 0, failed: 0, running: 0 },
        error: 'ecard-slack-triage.json: not valid JSON',
      },
    ]
    const { agents, sources } = rosterOf(`starting\n${JSON.stringify(list)}`)
    expect(SpecialistAgentsSchema.shape.agents.parse(agents)).toEqual(agents)
    expect(agents[0]).toMatchObject({
      format: 'folder',
      mode: null,
      fallbackModel: null,
      how: 'ask',
      runs: { week: 8, failed: 1, running: 1, lastAt: Date.parse('2026-11-17T10:00:00.000Z') },
      error: null,
    })
    expect(agents[1]).toMatchObject({
      format: 'file',
      enabled: false,
      mode: 'shadow',
      fallbackModel: 'anthropic/claude-sonnet-5-5',
      how: null,
      runs: { lastAt: null },
      error: 'ecard-slack-triage.json: not valid JSON',
    })
    expect(sources[1]!.knowledge).toEqual(['/Users/ike/Eva/references/slack-voice.md'])
    expect(() => rosterOf('error: boom')).toThrow()
  })
})

describe('agentFolderOf', () => {
  const bench = (dir: string) =>
    dir === `${DOMAINS}/design/bench`
      ? ['design-critic.ts', 'design-critic-cases.json', 'web.ts']
      : []

  it('opens an agent folder whole, on its AGENT.md', () => {
    const source = {
      id: 'diagram',
      file: `${DOMAINS}/diagram/agents/diagram/AGENT.md`,
      knowledge: [],
    }
    expect(agentFolderOf(source, ALLOWED, bench)).toEqual({
      root: `${DOMAINS}/diagram/agents/diagram`,
      entry: 'AGENT.md',
      only: null,
    })
  })

  it("shows a spec's own files in its domain folder: the spec, its knowledge there, its bench", () => {
    const source = {
      id: 'design-critic',
      file: `${DOMAINS}/design/design-critic.json`,
      knowledge: [`${DOMAINS}/design/design-critic.rules.md`, '/Users/ike/Eva/references/x.md'],
    }
    expect(agentFolderOf(source, ALLOWED, bench)).toEqual({
      root: `${DOMAINS}/design`,
      entry: 'design-critic.json',
      only: [
        'design-critic.json',
        'design-critic.rules.md',
        'bench/design-critic.ts',
        'bench/design-critic-cases.json',
      ],
    })
  })

  it('refuses code agents and files outside the installed service', () => {
    expect(() =>
      agentFolderOf({ id: 'x', file: undefined, knowledge: [] }, ALLOWED, bench),
    ).toThrow(/built in code/)
    expect(() =>
      agentFolderOf({ id: 'x', file: '/Users/ike/Eva/x.json', knowledge: [] }, ALLOWED, bench),
    ).toThrow(/not in the installed service/)
    expect(() =>
      agentFolderOf({ id: 'x', file: `${DOMAINS}/../../x.json`, knowledge: [] }, ALLOWED, bench),
    ).toThrow(/not in the installed service/)
  })
})
