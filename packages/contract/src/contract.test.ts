import { describe, expect, it } from 'vitest'
import {
  CanvasBoardSchema,
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  GateStatusSchema,
  eventContract,
  invokeContract,
} from './index'
import { ChatStatusSchema } from './chat'
import { CHAT_STATUSES } from '@evaos/chat-core/status'

describe('contract', () => {
  it('lists app.info as an invoke channel', () => {
    expect(INVOKE_CHANNELS).toContain('app.info')
    expect(Array.isArray(EVENT_CHANNELS)).toBe(true)
  })

  it('rejects app.info output missing evaRoot', () => {
    const bad = {
      configDir: '/x',
      ompBin: 'omp',
      sessionsDir: '/s',
      live: false,
      e2e: true,
      launchCount: 1,
      version: '1',
    }
    expect(invokeContract['app.info'].output.safeParse(bad).success).toBe(false)
  })

  it('rejects unknown input keys on app.info', () => {
    expect(invokeContract['app.info'].input.safeParse({ extra: 1 }).success).toBe(false)
    expect(invokeContract['app.info'].input.safeParse({}).success).toBe(true)
  })

  it('chat.snapshot output carries connected and error, not just running', () => {
    const base = {
      seq: 0,
      messages: [],
      meta: { model: null, thinking: null, contextTokens: null },
      running: false,
    }
    const out = invokeContract['chat.snapshot'].output
    expect(out.safeParse(base).success).toBe(false)
    expect(out.safeParse({ ...base, connected: false, error: 'ended' }).success).toBe(true)
    expect(out.safeParse({ ...base, connected: true, error: null }).success).toBe(true)
  })

  it('includes the Phase 2 channels', () => {
    for (const c of [
      'layout.load',
      'layout.save',
      'theme.load',
      'theme.save',
      'settings.load',
      'settings.save',
      'eva.sidebar',
      'app.setBackground',
      'app.quit',
      'app.unsavedEdits.reply',
      'app.saveDirty.reply',
    ])
      expect(INVOKE_CHANNELS).toContain(c)
    for (const c of [
      'app.hotkey',
      'app.unsavedEdits.request',
      'app.saveDirty.request',
      'app.windowShown',
    ])
      expect(EVENT_CHANNELS).toContain(c)
  })

  it('validates app.setBackground colors', () => {
    const i = invokeContract['app.setBackground'].input
    expect(i.safeParse({ color: 'red' }).success).toBe(false)
    expect(i.safeParse({ color: '#fff' }).success).toBe(false)
    expect(i.safeParse({ color: '#181817' }).success).toBe(true)
  })

  it('theme.save takes a config object and a preset name, nothing else', () => {
    const input = invokeContract['theme.save'].input
    const theme = { config: { primaryColor: 'teal', semantic: { light: {} } }, preset: 'custom' }
    expect(input.parse(theme)).toEqual(theme)
    expect(input.safeParse({ ...theme, extra: true }).success).toBe(false)
    for (const invalid of [
      {},
      { config: theme.config },
      { preset: 'default' },
      { config: [], preset: 'x' },
      { config: {}, preset: 1 },
    ]) {
      expect(input.safeParse(invalid).success).toBe(false)
    }
  })

  it('layout.save is strict and bounded', () => {
    const i = invokeContract['layout.save'].input
    const place = { page: 'home' }
    const tab = (n: number) => ({
      here: place,
      back: Array.from({ length: n }, () => place),
      forward: [],
      pinned: false,
    })
    expect(i.safeParse({ extra: 1 }).success).toBe(false)
    expect(i.safeParse({ tabs: { active: 0, list: [tab(51)] } }).success).toBe(false)
    expect(i.safeParse({ tabs: { active: 0, list: [tab(50)] } }).success).toBe(true)
    // The dockview layout is the saved panes now; the split tree it replaced is read, never saved.
    expect(i.safeParse({ dock: { grid: {}, panels: {} } }).success).toBe(true)
    expect(i.safeParse({ dock: [] }).success).toBe(false)
    expect(i.safeParse({ tiling: { version: 1, root: {} } }).success).toBe(false)
    expect(i.safeParse({ panelChoices: { a: true } }).success).toBe(false)
    expect(i.safeParse({ panelTool: 'files' }).success).toBe(false)
  })

  it('settings.save accepts partials', () => {
    expect(invokeContract['settings.save'].input.safeParse({ show_thinking: false }).success).toBe(
      true,
    )
  })

  it('app.info output defaults noMotion to false', () => {
    const out = invokeContract['app.info'].output.parse({
      evaRoot: '/e',
      configDir: '/c',
      ompBin: 'omp',
      sessionsDir: '/s',
      live: false,
      e2e: true,
      launchCount: 1,
      version: '1',
      instance: 'dev',
      build: null,
    })
    expect(out.noMotion).toBe(false)
  })

  it('app.info says which instance this is and its build', () => {
    const out = invokeContract['app.info'].output
    const base = {
      evaRoot: '/e',
      configDir: '/c',
      ompBin: 'omp',
      sessionsDir: '/s',
      live: true,
      e2e: false,
      launchCount: 1,
      version: '1',
    }
    expect(out.safeParse({ ...base, instance: 'stable', build: 'abc1234' }).success).toBe(true)
    expect(out.safeParse({ ...base, instance: 'live', build: null }).success).toBe(false)
    expect(out.safeParse(base).success).toBe(false)
  })

  it('carries the pending update over update.state and update.changed', () => {
    expect(INVOKE_CHANNELS).toEqual(expect.arrayContaining(['update.state', 'update.restart']))
    expect(EVENT_CHANNELS).toContain('update.changed')
    const s = eventContract['update.changed']
    expect(s.safeParse({ pending: true, build: 'abc', summary: 'Faster chat list' }).success).toBe(
      true,
    )
    expect(s.safeParse({ pending: false, build: null, summary: null }).success).toBe(true)
    expect(s.safeParse({ pending: true, build: 'x'.repeat(65), summary: null }).success).toBe(false)
    expect(invokeContract['update.restart'].input.safeParse({ now: true }).success).toBe(false)
  })

  it('eva and jobs inputs are strict and reject path-like ids', () => {
    const c = invokeContract
    expect(c['eva.workspace'].input.safeParse({ id: 'ok', x: 1 }).success).toBe(false)
    for (const id of ['../x', 'a/b'])
      expect(c['eva.workspace'].input.safeParse({ id }).success).toBe(false)
    expect(c['jobs.get'].input.safeParse({ name: 'Upper' }).success).toBe(false)
    expect(c['jobs.run'].input.safeParse({ name: 'a/b' }).success).toBe(false)
    expect(c['jobs.delete'].input.safeParse({ name: 'ok', y: 1 }).success).toBe(false)
  })

  it('eva.dashboard daily is exactly 90 and todo.add is bounded', () => {
    const ws = (n: number) => ({
      id: 'a',
      name: 'a',
      displayName: 'A',
      tagline: null,
      latest: null,
      lastActive: null,
      openTodos: 0,
      builtIn: false,
      hasFile: true,
      aliases: [],
      daily: Array.from({ length: n }, () => 0),
    })
    const d = (n: number) => ({
      today: '2026-10-15',
      generatedAt: 1,
      workspaces: [ws(n)],
      todos: [],
      updates7d: 0,
    })
    const out = invokeContract['eva.dashboard'].output
    expect(out.safeParse(d(90)).success).toBe(true)
    expect(out.safeParse(d(89)).success).toBe(false)
    const i = invokeContract['eva.todo.add'].input
    expect(i.safeParse({ tag: 'a', text: '' }).success).toBe(false)
    expect(i.safeParse({ tag: 'a', text: 'x'.repeat(2001) }).success).toBe(false)
    expect(i.safeParse({ tag: 'a', text: 'x' }).success).toBe(true)
  })

  it('jobs.save and jobs.list shapes', () => {
    const settings = { every: '1h', enabled: true, maxRun: '10m', keep: '5' }
    const i = invokeContract['jobs.save'].input
    expect(
      i.safeParse({ name: 'a', mode: 'create', basis: null, settings, steps: 's' }).success,
    ).toBe(true)
    expect(
      i.safeParse({ name: 'a', mode: 'update', basis: 'txt', settings, steps: 's' }).success,
    ).toBe(true)
    const job = {
      name: 'a',
      description: null,
      every: null,
      enabled: true,
      scheduled: false,
      maxRun: null,
      keep: null,
      lastRunAt: null,
      runState: 'other',
      runStateRaw: 'weird',
      runNote: null,
      sessionFile: null,
      nextDueAt: null,
      hasScript: false,
    }
    const out = invokeContract['jobs.list'].output
    expect(out.safeParse({ now: 1, jobs: [job] }).success).toBe(true)
    expect(out.safeParse({ now: 1, jobs: [{ ...job, runState: 'weird' }] }).success).toBe(false)
  })

  it('eva.changed payload', () => {
    const e = eventContract['eva.changed']
    expect(e.safeParse({ areas: ['memory'] }).success).toBe(true)
    expect(e.safeParse({ areas: ['x'] }).success).toBe(false)
  })

  it('GateStatusSchema is lenient', () => {
    const live = {
      locked: false,
      lockedAt: null,
      reason: null,
      active: null,
      plan: {
        date: '2026-10-15',
        breaks: [{ at: '2026-10-15T15:40:00.000Z', done: true }],
        source: 'calendar',
      },
      history: [
        {
          kind: 'habit',
          id: 'draw',
          name: 'Draw',
          startedAt: '2026-10-14T18:25:30.037Z',
          doneAt: '2026-10-14T18:37:31.001Z',
          photo: '/p/x.heic',
          override: null,
        },
      ],
      canFinish: false,
      remainingSeconds: 0,
      blocked: false,
      newField: 1,
    }
    expect(GateStatusSchema.safeParse(live).success).toBe(true)
    const empty = GateStatusSchema.parse({})
    expect(empty.locked).toBe(false)
    expect(empty.habits).toEqual([])
    expect(empty.history).toEqual([])
    const n = GateStatusSchema.parse({
      history: [{ kind: null, id: null, name: null, doneAt: 'x' }],
    })
    expect(n.history[0]).toMatchObject({ kind: '', id: '', name: '' })
    // The live gate sends remainingSeconds: null when no habit is running.
    expect(GateStatusSchema.parse({ active: null, remainingSeconds: null }).remainingSeconds).toBe(
      0,
    )
    expect(empty.remainingSeconds).toBe(0)
  })

  it('habit.run actions', () => {
    const i = invokeContract['habit.run'].input
    const ok = [
      { action: 'start', id: 'walk' },
      { action: 'done', id: 'walk', photoToken: null },
      { action: 'done', id: 'walk', photoToken: 'tok' },
      { action: 'override', reason: 'x' },
      { action: 'habit-add', name: 'W', minutes: 5, photo: false },
      { action: 'habit-edit', id: 'w', name: 'W', minutes: 5, photo: true },
      { action: 'habit-rm', id: 'w' },
      { action: 'task-add', name: 'T', minutes: null },
      { action: 'task-rm', id: 't' },
    ]
    for (const a of ok) expect(i.safeParse(a).success).toBe(true)
    const add = (minutes: number, name = 'W') => ({
      action: 'habit-add',
      name,
      minutes,
      photo: false,
    })
    for (const m of [0, 601, 2.5]) expect(i.safeParse(add(m)).success).toBe(false)
    expect(i.safeParse(add(5, 'x'.repeat(201))).success).toBe(false)
    expect(i.safeParse({ action: 'nope' }).success).toBe(false)
    expect(i.safeParse({ action: 'done', id: 'w', photoToken: null, photo: '/x' }).success).toBe(
      false,
    )
  })

  it('meetings inputs and get output', () => {
    const c = invokeContract
    for (const stem of ['a/b', '.hidden'])
      expect(c['meetings.get'].input.safeParse({ stem }).success).toBe(false)
    const out = c['meetings.get'].output
    expect(out.safeParse({ meeting: null, notes: 'none', protocol: null }).success).toBe(true)
  })

  it('includes every Phase 3 channel', () => {
    for (const ch of [
      'eva.dashboard',
      'eva.workspace',
      'eva.workspace.openFile',
      'eva.todo.preview',
      'eva.todo.add',
      'jobs.list',
      'jobs.get',
      'jobs.save',
      'jobs.setEnabled',
      'jobs.delete',
      'jobs.run',
      'habit.status',
      'habit.run',
      'habit.choosePhoto',
      'habit.openPhoto',
      'meetings.list',
      'meetings.get',
      'meetings.accept',
      'meetings.dismiss',
      'meetings.openNotes',
    ])
      expect(INVOKE_CHANNELS).toContain(ch)
    expect(EVENT_CHANNELS).toContain('eva.changed')
  })

  it('reads an append-only gate status past the old array caps', () => {
    const history = Array.from({ length: 6000 }, (_, i) => ({ kind: 'habit', id: `h${i}` }))
    const tasks = Array.from({ length: 2500 }, (_, i) => ({ id: `t${i}`, name: 'x' }))
    expect(GateStatusSchema.safeParse({ history, tasks }).success).toBe(true)
  })

  describe('canvas channels', () => {
    it('declares every channel and event', () => {
      for (const ch of [
        'canvas.list',
        'canvas.load',
        'canvas.save',
        'canvas.pages',
        'canvas.create',
        'canvas.rename',
        'canvas.delete',
        'canvas.pin',
        'canvas.image',
      ])
        expect(INVOKE_CHANNELS).toContain(ch)
      expect(EVENT_CHANNELS).toContain('canvas.changed')
      const changed = eventContract['canvas.changed']
      expect(changed.safeParse({ slug: null }).success).toBe(true)
      expect(changed.safeParse({ slug: 'ui-moodboard' }).success).toBe(true)
      expect(changed.safeParse({ slug: '../x' }).success).toBe(false)
    })

    it('slugs are plain file stems', () => {
      const load = invokeContract['canvas.load'].input
      for (const slug of ['ui-moodboard', 'a', '0-9', 'x'.repeat(80)])
        expect(load.safeParse({ slug }).success).toBe(true)
      for (const slug of ['', 'A', 'a b', 'a/b', '../a', 'a.json', 'x'.repeat(81)])
        expect(load.safeParse({ slug }).success).toBe(false)
    })

    it('board parsing strips unknown keys without filling optional ones', () => {
      const board = CanvasBoardSchema.parse({
        extra: 1,
        nodes: [{ id: 'a', type: 'note', data: { title: 't', foo: 1 }, z: 2 }],
        edges: [{ id: 'e', source: 'a', target: 'a', bar: 1 }],
      })
      expect(board).toEqual({
        version: 1,
        title: '',
        nodes: [{ id: 'a', type: 'note', data: { title: 't' } }],
        edges: [{ id: 'e', source: 'a', target: 'a' }],
      })
      expect(CanvasBoardSchema.safeParse({ version: 2 }).success).toBe(false)
      expect(CanvasBoardSchema.safeParse({ layout: 'radial' }).success).toBe(false)
      expect(CanvasBoardSchema.safeParse({ nodes: [{ id: 'a', type: 'sticker' }] }).success).toBe(
        false,
      )
    })

    it('save, rename, pin and image inputs are strict', () => {
      const c = invokeContract
      expect(c['canvas.save'].input.safeParse({ slug: 'a', board: {} }).success).toBe(true)
      expect(c['canvas.save'].input.safeParse({ slug: 'a', board: {}, x: 1 }).success).toBe(false)
      expect(c['canvas.rename'].input.safeParse({ slug: 'a', title: '  ' }).success).toBe(false)
      expect(c['canvas.pin'].input.safeParse({ slug: 'a', pinned: 'yes' }).success).toBe(false)
      expect(c['canvas.image'].input.safeParse({ slug: 'a', src: '' }).success).toBe(false)
      const img = c['canvas.image'].output
      expect(
        img.safeParse({ dataUrl: 'data:image/png;base64,AA', width: 1, height: null }),
      ).toMatchObject({
        success: true,
      })
      expect(img.safeParse({ dataUrl: 'data:text/html,x', width: 1, height: 1 }).success).toBe(
        false,
      )
    })
  })

  describe('phase 4 chat channels', () => {
    const png = { mimeType: 'image/png', data: 'AAA' }
    const send = invokeContract['chat.send'].input
    it('declares every channel and event', () => {
      for (const c of [
        'list',
        'setCollapsed',
        'setCategories',
        'archive',
        'pin',
        'rename',
        'delete',
        'openDraft',
        'answerUi',
        'goal',
        'models',
        'launchState',
        'setLaunch',
        'readImage',
        'readSubagent',
        'drop',
        'harnessStatus',
      ]) {
        expect(INVOKE_CHANNELS).toContain(`chat.${c}`)
      }
      expect(EVENT_CHANNELS).toContain('chat.listChanged')
      expect(EVENT_CHANNELS).toContain('chat.extras')
      expect(Object.keys(eventContract)).toContain('chat.extras')
    })
    it('chat.send text or images', () => {
      expect(send.safeParse({ paneId: 'p', text: '  ' }).success).toBe(false)
      expect(send.safeParse({ paneId: 'p', text: '', images: [png] }).success).toBe(true)
      expect(send.safeParse({ paneId: 'p', text: 'x', images: Array(9).fill(png) }).success).toBe(
        false,
      )
      expect(
        send.safeParse({
          paneId: 'p',
          text: 'x',
          images: [{ mimeType: 'image/svg+xml', data: 'A' }],
        }).success,
      ).toBe(false)
      expect(send.safeParse({ paneId: 'p', text: 'x', force: true }).success).toBe(true)
    })
    it('chat.goal takes only the strip ops', () => {
      const g = invokeContract['chat.goal'].input
      expect(g.safeParse({ paneId: 'p', op: 'pause' }).success).toBe(true)
      expect(g.safeParse({ paneId: 'p', op: 'create' }).success).toBe(false)
    })
    it('chat.rename validates and trims', () => {
      const r = invokeContract['chat.rename'].input
      expect(r.safeParse({ file: '/s/a.jsonl', name: '' }).success).toBe(false)
      expect(r.safeParse({ file: '/s/a.jsonl', name: 'x'.repeat(201) }).success).toBe(false)
      expect(r.parse({ file: '/s/a.jsonl', name: '  hi  ' }).name).toBe('hi')
    })
    it('archive and pin reject path-like ids', () => {
      expect(
        invokeContract['chat.archive'].input.safeParse({ id: '../x', archived: true }).success,
      ).toBe(false)
      expect(invokeContract['chat.pin'].input.safeParse({ id: '../x', pinned: true }).success).toBe(
        false,
      )
      expect(
        invokeContract['chat.pin'].input.safeParse({ id: 'abc_1.2-3', pinned: true }).success,
      ).toBe(true)
    })
    it('chat list order and agent channels validate their inputs', () => {
      for (const c of ['setAgent', 'markRead', 'snooze']) {
        expect(INVOKE_CHANNELS).toContain(`chat.${c}`)
      }
      const agent = invokeContract['chat.setAgent'].input
      expect(agent.safeParse({ agent: 'Elysia' }).success).toBe(true)
      expect(agent.safeParse({ agent: 'Astra' }).success).toBe(false)
      const snooze = invokeContract['chat.snooze'].input
      expect(snooze.safeParse({ id: 'abc', untilMs: 1_800_000_000_000 }).success).toBe(true)
      expect(snooze.safeParse({ id: 'abc', untilMs: null }).success).toBe(true)
      expect(snooze.safeParse({ id: 'abc', untilMs: -1 }).success).toBe(false)
      expect(snooze.safeParse({ id: '../x', untilMs: null }).success).toBe(false)
      expect(invokeContract['chat.markRead'].input.safeParse({ id: '../x' }).success).toBe(false)
    })
    it('chat.list rows carry the native look facts', () => {
      const row = {
        id: 'a',
        file: '/s/a.jsonl',
        title: 'A',
        mtimeMs: 1,
        archived: false,
        pinned: false,
        running: true,
        status: 'working',
        agent: 'Eren',
        workedIn: 'Relay',
        work: { key: 'ENG-7', branch: 'feat/ENG-7-x', pr: 225 },
        model: 'anthropic/claude-opus-5-5',
        jobs: 0,
        failed: false,
        returnedMs: 1,
        openedMs: null,
        keptMs: null,
        snoozedUntilMs: null,
        wokeMs: null,
        startedMs: 1,
        owner: { agent: 'astra', closed: false },
      }
      const prefs = {
        chat_categories: [],
        chat_group_order: [],
        chat_assignments: {},
        collapsed_groups: [],
        chat_agent: 'Eva',
      }
      const list = invokeContract['chat.list'].output
      expect(list.safeParse({ rows: [row], prefs, error: null }).success).toBe(true)
      expect(
        list.safeParse({ rows: [{ ...row, agent: 'Nova' }], prefs, error: null }).success,
      ).toBe(false)
      expect(
        list.safeParse({ rows: [{ ...row, work: { ...row.work, pr: 0 } }], prefs, error: null })
          .success,
      ).toBe(false)
    })
    it('launch patch strings cannot read as omp flags', () => {
      const r = invokeContract['chat.setLaunch'].input
      const ok = (launch: unknown) => r.safeParse({ paneId: 'pane-1', patch: launch }).success
      expect(ok({ model: { provider: 'anthropic', modelId: 'claude-opus-4.5' } })).toBe(true)
      expect(ok({ thinking: 'high' })).toBe(true)
      expect(ok({ thinking: '--approval-mode' })).toBe(false)
      expect(ok({ model: { provider: '-x', modelId: 'm' } })).toBe(false)
      expect(ok({ model: { provider: 'a', modelId: '--evil' } })).toBe(false)
    })

    it('chat.readImage only takes sha256 tokens', () => {
      const r = invokeContract['chat.readImage'].input
      expect(r.safeParse({ token: 'blob:sha256:XYZ' }).success).toBe(false)
      expect(r.safeParse({ token: '../../etc/passwd' }).success).toBe(false)
      expect(r.safeParse({ token: 'blob:sha256:' + 'a0'.repeat(32) }).success).toBe(true)
    })
    it('chat.readSubagent only takes absolute .jsonl paths', () => {
      const r = invokeContract['chat.readSubagent'].input
      expect(r.safeParse({ file: '/s/a/sub.jsonl' }).success).toBe(true)
      expect(r.safeParse({ file: 'a/sub.jsonl' }).success).toBe(false)
      expect(r.safeParse({ file: '/s/a/sub.txt' }).success).toBe(false)
      expect(r.safeParse({ file: '/s/a/sub.jsonl', paneId: 'p' }).success).toBe(false)
    })
    it('chat.answerUi accepts each response kind and rejects unknown', () => {
      const a = invokeContract['chat.answerUi'].input
      const ok = (response: unknown) => a.safeParse({ paneId: 'p', id: 'i', response }).success
      expect(ok({ kind: 'select', value: 'a' })).toBe(true)
      expect(ok({ kind: 'confirm', confirmed: true })).toBe(true)
      expect(ok({ kind: 'text', value: 'a' })).toBe(true)
      expect(
        ok({
          kind: 'ask',
          answers: [
            { id: 'q', picked: ['a'] },
            { id: 'r', typed: 'z' },
          ],
        }),
      ).toBe(true)
      expect(ok({ kind: 'cancel' })).toBe(true)
      expect(ok({ kind: 'nope' })).toBe(false)
    })
    it('chat.setLaunch rejects bad approval and extra keys', () => {
      const l = invokeContract['chat.setLaunch'].input
      expect(l.safeParse({ paneId: 'p', patch: { approval: 'none' } }).success).toBe(false)
      expect(l.safeParse({ paneId: 'p', patch: { extra: 1 } }).success).toBe(false)
      expect(l.safeParse({ paneId: 'p', patch: { approval: 'write', fast: true } }).success).toBe(
        true,
      )
    })
    it('ChatStatusSchema options equal CHAT_STATUSES', () => {
      expect(ChatStatusSchema.options).toEqual([...CHAT_STATUSES])
    })
    it('chat.open output accepts an owner and snapshot a dialog', () => {
      expect(
        invokeContract['chat.open'].output.safeParse({
          title: 't',
          messages: [],
          meta: { model: null, thinking: null, contextTokens: null },
          owner: 'p2',
        }).success,
      ).toBe(true)
    })
  })

  describe('browser scopes', () => {
    it('setScope, renameScope and pinTab validate bounded, strict inputs', () => {
      const set = invokeContract['browser.setScope'].input
      expect(set.safeParse({ scope: 'chat:/s/a.jsonl' }).success).toBe(true)
      expect(set.safeParse({ scope: '' }).success).toBe(false)
      expect(set.safeParse({ scope: 'x'.repeat(1025) }).success).toBe(false)
      expect(set.safeParse({ scope: 'page:dashboard', extra: 1 }).success).toBe(false)
      const rename = invokeContract['browser.renameScope'].input
      expect(rename.safeParse({ from: 'draft:3', to: 'chat:/s/n.jsonl' }).success).toBe(true)
      expect(rename.safeParse({ from: 'draft:3' }).success).toBe(false)
      const pin = invokeContract['browser.pinTab'].input
      expect(pin.safeParse({ tabId: 't1', pinned: true }).success).toBe(true)
      expect(pin.safeParse({ tabId: '../t1', pinned: true }).success).toBe(false)
      expect(pin.safeParse({ tabId: 't1' }).success).toBe(false)
    })

    it('snapshots carry the scope and each tab its pinned flag', () => {
      const tab = {
        id: 't1',
        url: '',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        blank: true,
        error: null,
        favicon: null,
      }
      const out = invokeContract['browser.setScope'].output
      const scope = 'page:dashboard'
      expect(out.safeParse({ tabs: [tab], activeId: 't1', scope }).success).toBe(false)
      expect(
        out.safeParse({ tabs: [{ ...tab, pinned: true }], activeId: 't1', scope }).success,
      ).toBe(true)
      expect(out.safeParse({ tabs: [], activeId: '', scope: '' }).success).toBe(true)
    })
  })

  describe('rooms channels', () => {
    it('lists the rooms channels and validates strict, bounded inputs', () => {
      for (const c of ['rooms.create', 'rooms.post', 'rooms.react', 'rooms.stop', 'rooms.list']) {
        expect(INVOKE_CHANNELS).toContain(c)
      }
      expect(EVENT_CHANNELS).toContain('rooms.changed')
      const create = invokeContract['rooms.create'].input
      expect(create.safeParse({ prompt: 'Should we?', agentIds: ['pm'] }).success).toBe(true)
      expect(create.safeParse({ prompt: '', agentIds: ['pm'] }).success).toBe(false)
      expect(create.safeParse({ prompt: 'x', agentIds: [] }).success).toBe(false)
      expect(create.safeParse({ prompt: 'x', agentIds: ['pm'], extra: 1 }).success).toBe(false)
      expect(invokeContract['rooms.post'].input.safeParse({ roomId: 'r', text: '' }).success).toBe(
        false,
      )
      expect(
        invokeContract['rooms.react'].input.safeParse({ roomId: 'r', messageId: 'm1', emoji: '👍' })
          .success,
      ).toBe(true)
    })

    it('a room carries phase, rounds, judge and the people without portraits', () => {
      const room = {
        id: 'r1',
        title: 't',
        prompt: 't',
        agents: [
          {
            id: 'pm',
            name: 'Jonah Reyes',
            title: 'PM',
            role: 'PM',
            brief: 'b',
            model: 'openai-codex/gpt-6.1-terra',
            tools: 'none',
            color: 'violet',
          },
        ],
        messages: [
          {
            id: 'm1',
            author: 'pm',
            text: 'hi',
            ts: 1,
            reactions: [{ emoji: '👍', by: ['isaac'] }],
            mentions: ['skeptic'],
            kind: 'message',
          },
        ],
        presence: { pm: { state: 'reading', detail: 'reading main/index.ts', since: 3 } },
        phase: 'wrapping',
        rounds: 3,
        judge: { verdict: 'continue', note: 'n', at: 2 },
        startedAt: 0,
      }
      expect(eventContract['rooms.changed'].safeParse({ room }).success).toBe(true)
      expect(
        eventContract['rooms.changed'].safeParse({ room: { ...room, phase: 'live' } }).success,
      ).toBe(false)
      expect(invokeContract['rooms.list'].output.safeParse({ rooms: [room] }).success).toBe(true)
    })
  })
})

describe('reactions channels', () => {
  it('watches by file and agent, and takes only valid threads, keys and emoji', () => {
    for (const c of ['reactions.watch', 'reactions.unwatch', 'reactions.react'])
      expect(INVOKE_CHANNELS).toContain(c)
    expect(EVENT_CHANNELS).toEqual(
      expect.arrayContaining(['reactions.changed', 'reactions.status']),
    )
    const react = invokeContract['reactions.react'].input
    const ok = { thread: 'session:s1', message: 'assistant@12', emoji: '👍', excerpt: 'x' }
    expect(react.safeParse(ok).success).toBe(true)
    expect(react.safeParse({ ...ok, emoji: null }).success).toBe(true)
    expect(react.safeParse({ ...ok, emoji: 'ok' }).success).toBe(false)
    expect(react.safeParse({ ...ok, message: 'tool@12' }).success).toBe(false)
    expect(react.safeParse({ ...ok, thread: 'room:x' }).success).toBe(false)
    expect(react.safeParse({ ...ok, excerpt: 'x'.repeat(201) }).success).toBe(false)
    const changed = eventContract['reactions.changed']
    expect(changed.safeParse({ thread: null, up: true, reactions: {} }).success).toBe(false)
    expect(
      invokeContract['reactions.watch'].output.safeParse({ thread: null, up: false, reactions: {} })
        .success,
    ).toBe(true)
  })
})
