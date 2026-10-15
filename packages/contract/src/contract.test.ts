import { describe, expect, it } from 'vitest'
import {
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
      'theme.setAppearance',
      'settings.load',
      'settings.save',
      'eva.sidebar',
      'app.setBackground',
      'app.quit',
      'app.unsavedEdits.reply',
      'app.saveDirty.reply',
    ])
      expect(INVOKE_CHANNELS).toContain(c)
    for (const c of ['app.hotkey', 'app.unsavedEdits.request', 'app.saveDirty.request'])
      expect(EVENT_CHANNELS).toContain(c)
  })

  it('validates app.setBackground colors', () => {
    const i = invokeContract['app.setBackground'].input
    expect(i.safeParse({ color: 'red' }).success).toBe(false)
    expect(i.safeParse({ color: '#fff' }).success).toBe(false)
    expect(i.safeParse({ color: '#181817' }).success).toBe(true)
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
    })
    expect(out.noMotion).toBe(false)
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
        'models',
        'launchState',
        'setLaunch',
        'readImage',
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
    it('chat.readImage only takes sha256 tokens', () => {
      const r = invokeContract['chat.readImage'].input
      expect(r.safeParse({ token: 'blob:sha256:XYZ' }).success).toBe(false)
      expect(r.safeParse({ token: '../../etc/passwd' }).success).toBe(false)
      expect(r.safeParse({ token: 'blob:sha256:' + 'a0'.repeat(32) }).success).toBe(true)
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
})
