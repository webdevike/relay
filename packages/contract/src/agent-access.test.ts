import { describe, expect, it } from 'vitest'
import { parseAppLink } from '@evaos/chat-core/widget'
import { agentActions, agentCatalog, type AgentActionSpec } from './agent'
import {
  AGENT_PAGES,
  AGENT_SETTING_KEYS,
  AGENT_SETTINGS_SECTIONS,
  AgentLinkParamsSchema,
  CONNECTION_IDS,
  ConnectResultSchema,
  ConnectionSchema,
  appLinkFor,
  parseSettingValue,
  settingsSectionOf,
} from './agent-access'
import { EVENT_CHANNELS, INVOKE_CHANNELS } from './index'

describe('agent access actions', () => {
  it('serve their params as JSON Schema with the sides and flags they need', () => {
    const catalog = agentCatalog()
    for (const id of [
      'describe',
      'pages.list',
      'settings.get',
      'settings.set',
      'settings.undo',
      'connections.list',
      'connections.add',
      'connections.remove',
      'link',
      'link.open',
      'tour.highlight',
      'tour.clear',
    ]) {
      const entry = catalog.find((c) => c.id === id)
      expect(entry, id).toBeDefined()
      expect(entry!.params).toMatchObject({ type: 'object' })
      expect(entry!.description).not.toMatch(/\u2014/)
    }
    const set: AgentActionSpec = agentActions['settings.set']
    expect([set.side, set.focus, set.destructive, set.scoped]).toEqual([
      'renderer',
      'none',
      false,
      true,
    ])
    const remove: AgentActionSpec = agentActions['connections.remove']
    expect([remove.side, remove.destructive]).toEqual(['main', true])
    expect(agentActions['link.open'].focus).toBe('main')
    expect(agentActions['tour.highlight'].focus).toBe('none')
    expect(INVOKE_CHANNELS).toEqual(
      expect.arrayContaining(['connections.list', 'connections.connect', 'app.pendingLinks']),
    )
    expect(EVENT_CHANNELS).toEqual(expect.arrayContaining(['connections.changed', 'app.openLink']))
  })

  it('validate tour, link.open and connection params', () => {
    const tour = agentActions['tour.highlight'].params
    expect(tour.safeParse({ target: 'theme-color-scheme', caption: 'Light or dark' }).success).toBe(
      true,
    )
    expect(tour.safeParse({ target: 'a b', caption: 'x' }).success).toBe(false)
    expect(tour.safeParse({ target: 'x', caption: '  ' }).success).toBe(false)
    expect(tour.safeParse({ target: 'x', caption: 'y', ms: 10 }).success).toBe(false)
    const open = agentActions['link.open'].params
    expect(open.safeParse({ url: 'relay://open/settings/connections' }).success).toBe(true)
    expect(open.safeParse({ url: 'https://example.com' }).success).toBe(false)
    expect(open.safeParse({ url: 'relay://open/jobs', target: 'window' }).success).toBe(false)
    const add = agentActions['connections.add'].params
    expect(add.safeParse({ id: 'github' }).success).toBe(true)
    expect(add.safeParse({ id: 'linear', secret: `lin_api_${'a'.repeat(40)}` }).success).toBe(true)
    expect(add.safeParse({ id: 'linear', secret: 'hunter2' }).success).toBe(false)
    expect(add.safeParse({ id: 'github', secret: `lin_api_${'a'.repeat(40)}` }).success).toBe(false)
    expect(add.safeParse({ id: 'dropbox' }).success).toBe(false)
  })

  it('list every page with a deep link that parses, and each connection and settings section', () => {
    for (const p of AGENT_PAGES) {
      expect(p.link.startsWith('relay://'), p.key).toBe(true)
      if (!p.link.includes('<')) expect(parseAppLink(p.link), p.link).not.toBeNull()
    }
    expect(AGENT_PAGES.find((p) => p.key === 'settings')?.sections).toEqual(AGENT_SETTINGS_SECTIONS)
    expect(CONNECTION_IDS).toEqual(
      expect.arrayContaining(['github', 'linear', 'relay-host', 'anthropic']),
    )
    expect(settingsSectionOf('connections')).toBe('Connections')
    expect(settingsSectionOf('nope')).toBeNull()
  })

  it('shapes connections without room for a secret', () => {
    const row = {
      id: 'linear',
      title: 'Linear',
      kind: 'key',
      status: 'connected',
      account: 'Isaac',
      detail: "Key saved in Relay's config",
      usedBy: 'Reviews',
      canAdd: true,
      canRemove: true,
      link: 'relay://open/settings/connections?connect=linear',
    }
    expect(ConnectionSchema.parse({ ...row, secret: 'lin_api_x' })).not.toHaveProperty('secret')
    expect(
      ConnectResultSchema.safeParse({
        status: 'needs-user',
        id: 'github',
        link: 'relay://open/settings/connections?connect=github',
        step: 'Click Connect.',
      }).success,
    ).toBe(true)
  })
})

describe('settings.set validation', () => {
  const set = agentActions['settings.set'].params

  it('takes each key with a value of its type', () => {
    for (const [key, value] of [
      ['theme.mode', 'dark'],
      ['theme.preset', 'Ocean'],
      ['theme.primaryColor', 'teal'],
      ['theme.radius', 'lg'],
      ['theme.scale', 1.1],
      ['theme.fontFamily', 'Inter, Arial, sans-serif'],
      ['theme.colors.dark.body', '#102027'],
      ['theme.colors.light.text', '#212529'],
      ['chat.showThinking', false],
      ['chat.harness', 'claude'],
    ] as const) {
      expect(set.safeParse({ key, value }).success, key).toBe(true)
      expect(parseSettingValue(key, value)).toEqual({ ok: true, value })
    }
    expect(AGENT_SETTING_KEYS).toHaveLength(9 + 20)
  })

  it('refuses unknown keys, wrong types, bad colors and extra fields, saying why', () => {
    for (const [key, value] of [
      ['theme.mode', 'sepia'],
      ['theme.mode', true],
      ['theme.primaryColor', 'chartreuse'],
      ['theme.scale', 3],
      ['theme.scale', '1'],
      ['theme.colors.dark.body', 'red'],
      ['theme.colors.dark.body', '#12345'],
      ['theme.colors.dark.nope', '#123456'],
      ['theme.fontFamily', 'Inter; color: red'],
      ['theme.preset', ''],
      ['chat.showTools', 'yes'],
      ['window.opacity', 0.5],
      ['__proto__', 1],
    ] as const) {
      expect(set.safeParse({ key, value }).success, `${key}=${String(value)}`).toBe(false)
    }
    expect(set.safeParse({ key: 'theme.mode', value: 'dark', extra: 1 }).success).toBe(false)
    const bad = parseSettingValue('theme.colors.dark.body', 'red')
    expect(bad).toEqual({ ok: false, message: 'theme.colors.dark.body: a #rrggbb color' })
    expect(parseSettingValue('nope', 1)).toMatchObject({ ok: false, message: /No setting nope/ })
  })
})

describe('link', () => {
  const link = (p: object) => appLinkFor(AgentLinkParamsSchema.parse(p))

  it('builds deep links that parse back to the same place', () => {
    const cases: Array<[object, string, string]> = [
      [
        { connection: 'github' },
        'relay://open/settings/connections?connect=github',
        'Settings › Connections › GitHub',
      ],
      [
        { page: 'settings', section: 'Connections' },
        'relay://open/settings/connections',
        'Settings › Connections',
      ],
      [
        { setting: 'theme.mode' },
        'relay://open/settings/theme?setting=theme.mode',
        'Settings › Theme › Appearance',
      ],
      [{ page: 'jobs' }, 'relay://open/jobs', 'Jobs'],
      [{ page: 'agent:nova' }, 'relay://assistant/nova', 'Assistant nova'],
      [{ page: 'workspace:ecard' }, 'relay://open/workspace/ecard', 'Workspace ecard'],
      [
        { page: 'test-bench', experiment: 'eva-hillclimb', arm: 'a2' },
        'relay://open/test-bench?experiment=eva-hillclimb&arm=a2',
        'Test Bench',
      ],
      [{ page: 'skills', skill: 'canvas' }, 'relay://open/skills?skill=canvas', 'Skills'],
      [
        { page: 'reviews', item: 'https://github.com/o/r/pull/12' },
        'relay://open/reviews?item=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F12',
        'Reviews',
      ],
    ]
    for (const [params, url, label] of cases) {
      const out = link(params)
      expect(out).toEqual({ url, label, markdown: `[${label}](${url})` })
      expect(parseAppLink(out.url)).not.toBeNull()
    }
    expect(parseAppLink(link({ page: 'reviews', item: 'https://x.dev/a?b=1&c=2' }).url)).toEqual({
      kind: 'open',
      page: 'reviews',
      params: { item: 'https://x.dev/a?b=1&c=2' },
    })
    expect(link({ connection: 'linear', label: 'Connect [Linear]' }).markdown).toBe(
      '[Connect Linear](relay://open/settings/connections?connect=linear)',
    )
  })

  it('refuses parts that do not belong together', () => {
    expect(AgentLinkParamsSchema.safeParse({}).success).toBe(false)
    expect(AgentLinkParamsSchema.safeParse({ page: 'nope' }).success).toBe(false)
    expect(AgentLinkParamsSchema.safeParse({ setting: 'theme.nope' }).success).toBe(false)
    expect(AgentLinkParamsSchema.safeParse({ page: 'workspace:Has Space' }).success).toBe(false)
    expect(() => link({ page: 'jobs', section: 'Theme' })).toThrow(/settings page/)
    expect(() => link({ page: 'jobs', item: 'https://x.dev' })).toThrow(/item belongs to reviews/)
    expect(() => link({ page: 'jobs', skill: 'canvas' })).toThrow(/skill belongs to skills/)
    expect(() => link({ page: 'test-bench', arm: 'a' })).toThrow(/arm needs experiment/)
  })
})
