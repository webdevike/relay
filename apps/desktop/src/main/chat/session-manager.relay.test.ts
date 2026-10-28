import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '@evaos/chat-core/line-framer'
import type { ChatTransport, TransportExit } from '@evaos/chat-core/transport'
import type { ChatMessage, SessionMeta } from '@evaos/chat-core/message'
import { makeMessage } from '@evaos/chat-core/message'
import type { ParsedSession } from '@evaos/chat-core/session'
import type { Batch } from '@evaos/contract'
import { RelayCommandError, type RelayLink, type RelaySessionEvent } from '../relay/client'
import type { RelayCommand } from '../relay/commands'
import type { RelaySession } from '../relay/feed'
import {
  APPROVE_ON_PHONE,
  AWAY_SETTING,
  CANT_REACH,
  MAYBE_RUNNING_ELSEWHERE,
  MINI_CANT_REACH,
  MINI_DOWN,
  MINI_GOAL,
  SessionManager,
  type SessionManagerDeps,
} from './session-manager'
import { MINI_STARTING_TEXT, STARTING_TEXT, STREAM_ROW } from './remote'

const TAG = '<surface>Mac - Relay Desktop</surface>\n'
const FILE = '/s/2026_out.jsonl'
const meta: SessionMeta = { model: null, thinking: null, contextTokens: null }

/** Relay as the manager sees it: a session list, subscriptions, commands and events. */
class FakeLink implements RelayLink {
  list: Map<string, RelaySession> | null = null
  subs = new Set<string>()
  log: string[] = []
  commands: RelayCommand[] = []
  /** The next command is refused with this. */
  refuse: RelayCommandError | null = null
  /** Runs inside command(), before it settles (an event that beats the ack). */
  during: (() => void) | null = null
  private changes = new Set<() => void>()
  private listeners = new Set<(e: RelaySessionEvent) => void>()
  sessions() {
    return this.list
  }
  onChange(cb: () => void) {
    this.changes.add(cb)
    return () => this.changes.delete(cb)
  }
  onEvent(cb: (e: RelaySessionEvent) => void) {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  boards() {
    return null
  }
  onBoardsChange() {
    return () => undefined
  }
  subscribe(id: string) {
    this.subs.add(id)
    this.log.push(`subscribe ${id}`)
  }
  unsubscribe(id: string) {
    this.subs.delete(id)
    this.log.push(`unsubscribe ${id}`)
  }
  async command(cmd: RelayCommand) {
    this.commands.push(cmd)
    this.log.push(`cmd ${cmd.kind}`)
    this.during?.()
    this.during = null
    const refused = this.refuse
    this.refuse = null
    if (refused) throw refused
  }
  set(sessions: Array<Partial<RelaySession> & { id: string }> | null) {
    this.list =
      sessions === null
        ? null
        : new Map(
            sessions.map((s) => [
              s.id,
              {
                status: 'idle',
                detail: null,
                canRespond: true,
                kind: 'manual',
                title: '',
                assistant: null,
                ...s,
              } satisfies RelaySession,
            ]),
          )
    for (const cb of [...this.changes]) cb()
  }
  emit(e: RelaySessionEvent) {
    for (const cb of [...this.listeners]) cb(e)
  }
}

class StubTransport implements ChatTransport {
  readonly kind = 'memory'
  started = 0
  sent: string[] = []
  start() {
    this.started += 1
    return Promise.resolve()
  }
  send(text: string) {
    this.sent.push(text)
    return Promise.resolve()
  }
  steer(text: string) {
    return this.send(text)
  }
  abort() {
    return Promise.resolve()
  }
  write() {
    return Promise.resolve()
  }
  close(): Promise<TransportExit> {
    return Promise.resolve({ code: 0, signal: null, timedOut: false })
  }
  onFrame(_cb: (f: Frame) => void) {
    return () => undefined
  }
}

const user = (id: string, text: string): ChatMessage => makeMessage(id, 'user', text)
const reply = (id: string, text: string): ChatMessage => makeMessage(id, 'assistant', text)

function setup(deps: Partial<SessionManagerDeps> = {}) {
  vi.useFakeTimers()
  const relay = new FakeLink()
  const files = new Map<string, ParsedSession>()
  const transports: StubTransport[] = []
  const batches: Batch[] = []
  const logs: string[] = []
  const mgr = new SessionManager({
    createTransport: () => {
      const t = new StubTransport()
      transports.push(t)
      return t
    },
    emit: (b) => batches.push(b),
    cwd: '/eva',
    machineLabel: 'Mac',
    realpath: (f) => f,
    stat: () => Date.now() - 60_000,
    relay,
    readSession: (f) => files.get(f) ?? null,
    log: (l) => logs.push(l),
    ...deps,
  })
  /** omp writes the session file: the manager hears the change and reads it. */
  const write = (
    file: string,
    messages: ChatMessage[],
    m: Partial<SessionMeta> = {},
    named: string | null = null,
  ) => {
    files.set(file, { messages, meta: { ...meta, ...m }, title: named ?? '', named })
    mgr.filesChanged([file])
  }
  const shown = (paneId = 'pane-1') =>
    mgr.snapshot(paneId).messages.map((m) => `${m.role}:${m.text}${m.unconfirmed ? '?' : ''}`)
  return { mgr, relay, transports, batches, logs, write, shown }
}

afterEach(() => vi.useRealTimers())

describe('SessionManager with Relay: chats omp runs outside this app', () => {
  it('opens a live outside session as an away chat and subscribes to it once', () => {
    const { mgr, relay, batches } = setup()
    relay.set([{ id: 'out', status: 'working', kind: 'job' }])
    mgr.open('pane-1', FILE, [user('u1', 'hi')], meta)
    // Nothing goes out inside `chat.open`: the pane's first batch follows its answer.
    expect(batches).toEqual([])
    expect([...relay.subs]).toEqual(['out'])
    expect(mgr.snapshot('pane-1')).toMatchObject({
      running: true,
      connected: true,
      away: { job: true },
    })
    vi.advanceTimersByTime(16)
    expect(batches.at(-1)?.ops.at(-1)).toEqual({
      op: 'meta',
      patch: { running: true, away: { job: true }, connected: true },
    })
    // A second pane on the same session shares the subscription.
    mgr.open('pane-2', FILE, [], meta)
    expect(relay.log.filter((l) => l.startsWith('subscribe'))).toEqual(['subscribe out'])
    mgr.openDraft('pane-1', meta)
    mgr.openDraft('pane-2', meta)
    expect(relay.log.at(-1)).toBe('unsubscribe out')
  })

  it('shows the streamed reply live and drops it once the file has it, without a duplicate', () => {
    const { mgr, relay, write, shown } = setup()
    relay.set([{ id: 'out', status: 'working' }])
    mgr.open('pane-1', FILE, [user('u1', 'hi')], meta)
    relay.emit({ kind: 'stream', session: 'out', id: 'm1', text: 'Fox', streaming: true })
    relay.emit({ kind: 'stream', session: 'out', id: 'm1', text: 'Foxes hunt', streaming: true })
    expect(shown()).toEqual(['user:hi', 'assistant:Foxes hunt'])
    expect(mgr.snapshot('pane-1').messages.at(-1)).toMatchObject({
      id: STREAM_ROW,
      streaming: true,
    })
    relay.emit({
      kind: 'stream',
      session: 'out',
      id: 'm1',
      text: 'Foxes hunt at night.',
      streaming: false,
    })
    expect(shown()).toEqual(['user:hi', 'assistant:Foxes hunt at night.'])
    write(FILE, [user('u1', 'hi'), reply('a1', 'Foxes hunt at night.')])
    expect(shown()).toEqual(['user:hi', 'assistant:Foxes hunt at night.'])
    expect(mgr.snapshot('pane-1').messages.map((m) => m.id)).toEqual(['u1', 'a1'])
    // A stream for a session no pane shows is not kept.
    relay.emit({ kind: 'stream', session: 'other', id: 'x', text: 'nope', streaming: true })
    expect(shown()).toHaveLength(2)
  })

  it('a finished stream the file already has never shows twice', () => {
    const { mgr, relay, shown } = setup()
    relay.set([{ id: 'out', status: 'idle' }])
    mgr.open('pane-1', FILE, [user('u1', 'hi'), reply('a1', 'Done.')], meta)
    relay.emit({ kind: 'stream', session: 'out', id: 'm1', text: 'Done.', streaming: false })
    expect(shown()).toEqual(['user:hi', 'assistant:Done.'])
  })

  it('a reply is the same agent.reply whether the session works (steer) or idles (prompt)', async () => {
    const { mgr, relay, write, shown, transports } = setup()
    relay.set([{ id: 'out', status: 'working' }])
    mgr.open('pane-1', FILE, [user('u1', 'hi')], meta)
    relay.emit({ kind: 'stream', session: 'out', id: 'm1', text: 'Thinking', streaming: true })
    await mgr.send('pane-1', 'steer this way')
    // Like native, the reply streaming in stays last, under the steer.
    expect(shown()).toEqual(['user:hi', 'user:steer this way?', 'assistant:Thinking'])
    relay.emit({
      kind: 'stream',
      session: 'out',
      id: 'm1',
      text: 'Thinking done',
      streaming: false,
    })
    relay.set([{ id: 'out', status: 'idle' }])
    await mgr.send('pane-1', 'next turn', { images: [{ mimeType: 'image/png', data: 'AAA' }] })
    expect(relay.commands).toEqual([
      { kind: 'agent.reply', sessionId: 'out', text: `${TAG}steer this way`, submit: true },
      {
        kind: 'agent.reply',
        sessionId: 'out',
        text: `${TAG}next turn`,
        submit: true,
        images: [{ mimeType: 'image/png', data: 'AAA' }],
      },
    ])
    expect(transports).toEqual([])
    expect(shown()).toEqual([
      'user:hi',
      'user:steer this way?',
      'user:next turn?',
      'assistant:Thinking done',
    ])
    // Each prompt shows until the file has it, once; the reply once the file has it too.
    write(FILE, [user('u1', 'hi'), user('u2', 'steer this way'), reply('a1', 'Thinking done')])
    expect(shown()).toEqual([
      'user:hi',
      'user:steer this way',
      'assistant:Thinking done',
      'user:next turn?',
    ])
    write(FILE, [
      user('u1', 'hi'),
      user('u2', 'steer this way'),
      reply('a1', 'Thinking done'),
      user('u3', 'next turn'),
    ])
    expect(shown()).toEqual([
      'user:hi',
      'user:steer this way',
      'assistant:Thinking done',
      'user:next turn',
    ])
  })

  it("says Relay's refusal and takes the prompt back; a GIF is refused before sending", async () => {
    const { mgr, relay, shown } = setup()
    relay.set([{ id: 'out' }])
    mgr.open('pane-1', FILE, [], meta)
    relay.refuse = new RelayCommandError('agent_cannot_respond', 'session is gone')
    await expect(mgr.send('pane-1', 'hello')).rejects.toMatchObject({
      code: 'relay-failed',
      message: "Relay couldn't send that. session is gone",
    })
    expect(shown()).toEqual([])
    await expect(
      mgr.send('pane-1', 'pic', { images: [{ mimeType: 'image/gif', data: 'G' }] }),
    ).rejects.toMatchObject({ code: 'relay-image' })
    expect(relay.commands).toHaveLength(1)
  })

  it('stops through Relay, cancelling a question first', async () => {
    const { mgr, relay } = setup()
    relay.set([{ id: 'out', status: 'working', detail: 'ask' }])
    mgr.open('pane-1', FILE, [], meta)
    relay.emit({
      kind: 'ask',
      session: 'out',
      ask: {
        id: 'k1',
        questions: [
          {
            id: 'q',
            question: 'Go?',
            header: null,
            options: [{ label: 'Yes', description: null }],
            multi: false,
            recommended: null,
          },
        ],
      },
    })
    expect(await mgr.abort('pane-1')).toBe(true)
    expect(relay.commands).toEqual([
      { kind: 'agent.ask.cancel', sessionId: 'out', askId: 'k1' },
      { kind: 'agent.abort', sessionId: 'out' },
    ])
    relay.refuse = new RelayCommandError('internal', 'no')
    expect(await mgr.abort('pane-1')).toBe(false)
    expect(mgr.snapshot('pane-1').error).toBe("Relay couldn't stop it. no")
  })

  it('shows an ask as the question card and answers it through Relay', async () => {
    const { mgr, relay, shown } = setup()
    relay.set([{ id: 'out', status: 'waiting' }])
    mgr.open('pane-1', FILE, [user('u1', 'hi')], meta)
    relay.emit({
      kind: 'ask',
      session: 'out',
      ask: {
        id: 'k1',
        questions: [
          {
            id: 'q1',
            question: 'Which color?',
            header: 'Theme',
            options: [
              { label: 'Blue', description: 'calm' },
              { label: 'Red', description: null },
            ],
            multi: false,
            recommended: 0,
          },
        ],
      },
    })
    expect(mgr.snapshot('pane-1').dialog).toEqual({
      kind: 'ask',
      id: 'ask:k1',
      questions: [
        {
          id: 'q1',
          question: 'Which color?',
          header: 'Theme',
          options: [{ label: 'Blue', description: 'calm' }, { label: 'Red' }],
          recommended: 0,
          multi: false,
        },
      ],
    })
    expect(shown()).toEqual(['user:hi', 'notice:Which color?'])
    // A stale id answers nothing.
    expect(await mgr.answerUi('pane-1', 'ask:old', { kind: 'cancel' })).toBe(false)
    // Relay's resolved frame can beat the ack.
    relay.during = () => relay.emit({ kind: 'askResolved', session: 'out', id: 'k1' })
    expect(
      await mgr.answerUi('pane-1', 'ask:k1', {
        kind: 'ask',
        answers: [{ id: 'q1', picked: ['Blue'] }],
      }),
    ).toBe(true)
    expect(relay.commands).toEqual([
      {
        kind: 'agent.ask.answer',
        sessionId: 'out',
        askId: 'k1',
        results: [{ id: 'q1', selectedOptions: ['Blue'] }],
      },
    ])
    expect(mgr.snapshot('pane-1').dialog).toBeNull()
    expect(shown()).toEqual(['user:hi', 'notice:Answered: Blue'])
  })

  it('shows an approval as a confirm card: Confirm approves from the desktop, Decline denies', async () => {
    const { mgr, relay } = setup()
    relay.set([{ id: 'out', status: 'needs_permission', detail: 'bash' }])
    mgr.open('pane-1', FILE, [], meta)
    const approval = (id: string) =>
      relay.emit({
        kind: 'approval',
        session: 'out',
        approval: {
          id,
          tool: 'bash',
          command: 'rm -rf build',
          reason: null,
          destructive: 'rm -rf',
        },
      })
    approval('c1')
    expect(mgr.snapshot('pane-1').dialog).toEqual({
      kind: 'confirm',
      id: 'approval:c1',
      title: 'bash needs approval',
      message: 'rm -rf build\nDestructive: rm -rf',
    })
    await mgr.answerUi('pane-1', 'approval:c1', { kind: 'confirm', confirmed: true })
    approval('c2')
    await mgr.answerUi('pane-1', 'approval:c2', { kind: 'cancel' })
    expect(relay.commands).toEqual([
      { kind: 'agent.approve', sessionId: 'out', approvalId: 'c1', confirmed: 'desktop' },
      { kind: 'agent.deny', sessionId: 'out', approvalId: 'c2' },
    ])
    // Settled at the terminal: the card goes.
    approval('c3')
    relay.emit({ kind: 'approvalResolved', session: 'out', id: 'c3' })
    expect(mgr.snapshot('pane-1').dialog).toBeNull()
  })

  it('switches model and thinking through Relay and shows the choice until the file has it', async () => {
    const { mgr, relay, write } = setup()
    relay.set([{ id: 'out' }])
    mgr.open('pane-1', FILE, [], { ...meta, model: ['anthropic', 'old'] })
    const state = await mgr.setLaunch('pane-1', {
      model: { provider: 'openai', modelId: 'gpt-6' },
      thinking: 'high',
    })
    expect(relay.commands).toEqual([
      {
        kind: 'agent.configure',
        sessionId: 'out',
        model: { provider: 'openai', id: 'gpt-6' },
        thinkingLevel: 'high',
      },
    ])
    expect(state).toMatchObject({ model: ['openai', 'gpt-6'], thinking: 'high', harness: 'omp' })
    await expect(mgr.setLaunch('pane-1', { approval: 'write' })).rejects.toMatchObject({
      message: AWAY_SETTING,
    })
    write(FILE, [], { model: ['openai', 'gpt-6'], thinking: 'high' })
    expect(mgr.snapshot('pane-1').meta).toMatchObject({
      model: ['openai', 'gpt-6'],
      thinking: 'high',
    })
    expect(mgr.launchState('pane-1')).toMatchObject({
      model: ['openai', 'gpt-6'],
      thinking: 'high',
    })
  })

  it('renames a live outside session through Relay; not one this app runs or Relay lacks', async () => {
    const { mgr, relay } = setup()
    relay.set([{ id: 'out' }])
    expect(await mgr.renameAway(FILE, 'Better name')).toBe(true)
    expect(await mgr.renameAway('/s/2026_gone.jsonl', 'x')).toBe(false)
    expect(relay.commands).toEqual([
      { kind: 'agent.configure', sessionId: 'out', title: 'Better name' },
    ])
  })

  it("offers the takeover only when Relay can't reach the session or Relay is down", async () => {
    const { mgr, relay, transports } = setup({ stat: () => Date.now() })
    relay.set([{ id: 'out', canRespond: false }])
    mgr.open('pane-1', FILE, [], meta)
    await expect(mgr.send('pane-1', 'hi')).rejects.toMatchObject({
      code: 'owned-elsewhere',
      message: CANT_REACH,
    })
    // Continue anyway: a local omp resumes it.
    await mgr.send('pane-1', 'hi', { force: true })
    expect(transports).toHaveLength(1)
    expect(mgr.snapshot('pane-1').away).toBeNull()

    // Relay up and not hearing the session: it runs nowhere, so no prompt even if just written.
    mgr.open('pane-2', '/s/2026_idle.jsonl', [], meta)
    await mgr.send('pane-2', 'resume')
    expect(transports).toHaveLength(2)

    // Relay down: the recently-active fallback asks first.
    relay.set(null)
    mgr.open('pane-3', '/s/2026_maybe.jsonl', [], meta)
    await expect(mgr.send('pane-3', 'x')).rejects.toMatchObject({
      message: MAYBE_RUNNING_ELSEWHERE,
    })
  })

  it('a session that ends, or Relay going down, turns the pane back into a saved session', () => {
    const { mgr, relay } = setup()
    relay.set([{ id: 'out', status: 'working' }])
    mgr.open('pane-1', FILE, [], meta)
    relay.emit({ kind: 'stream', session: 'out', id: 'm', text: 'partial', streaming: true })
    relay.set(null)
    expect(mgr.snapshot('pane-1')).toMatchObject({
      running: false,
      connected: false,
      away: null,
      messages: [],
    })
    relay.set([{ id: 'out', status: 'idle' }])
    expect(mgr.snapshot('pane-1').away).toEqual({ job: false })
    relay.set([{ id: 'out', status: 'ended' }])
    expect(mgr.snapshot('pane-1').away).toBeNull()
    expect([...relay.subs]).toEqual([])
  })
})
describe('SessionManager with Relay: the pane title', () => {
  it("follows the session's name: omp's in its file first, else what Relay calls it", () => {
    const { mgr, relay, write, batches } = setup()
    relay.set([{ id: 'out', title: 'Relay desktop check' }])
    mgr.open('pane-1', FILE, [], meta)
    expect(mgr.snapshot('pane-1').title).toBe('Relay desktop check')
    vi.advanceTimersByTime(16)
    expect(batches.flatMap((b) => b.ops)).toContainEqual({
      op: 'meta',
      patch: expect.objectContaining({ title: 'Relay desktop check' }),
    })
    relay.set([{ id: 'out', title: 'Renamed on the phone' }])
    expect(mgr.snapshot('pane-1').title).toBe('Renamed on the phone')
    // A name in the file wins, and a later rename there (a title record, no message) follows.
    write(FILE, [], {}, 'Named in omp')
    expect(mgr.snapshot('pane-1').title).toBe('Named in omp')
    write(FILE, [], {}, 'Renamed in omp')
    expect(mgr.snapshot('pane-1').title).toBe('Renamed in omp')
  })

  it("starts from the file's name when the chat opens", () => {
    const { mgr, relay } = setup()
    relay.set([{ id: 'out', title: 'Relay title' }])
    mgr.open('pane-1', FILE, [], meta, 'File name')
    expect(mgr.snapshot('pane-1').title).toBe('File name')
  })
})

describe('SessionManager with Relay: new chats in herdr', () => {
  const herdrFile = '/s/2026_new.jsonl'

  it('starts omp in herdr, shows Starting omp in herdr and sends the prompt once omp joins', async () => {
    const herdr = vi.fn(async () => herdrFile)
    const { mgr, relay, write, shown, transports, batches } = setup({
      herdr,
      launchArgs: () => ['--approval-mode', 'yolo'],
    })
    relay.set([])
    mgr.openDraft('pane-1', meta)
    const { promise, resolve } = Promise.withResolvers<string>()
    herdr.mockImplementationOnce(() => promise)
    const sending = mgr.send('pane-1', 'hello herdr')
    // The prompt and the starting row show at once.
    expect(shown()).toEqual(['user:hello herdr?', `notice:${STARTING_TEXT}`])
    expect(batches.at(-1)?.ops.some((o) => o.op === 'upsert')).toBe(true)
    expect(mgr.snapshot('pane-1').away).toEqual({ job: false })
    // A second message while omp starts waits behind the first.
    await mgr.send('pane-1', 'and then')
    resolve(herdrFile)
    await sending
    expect(herdr).toHaveBeenCalledWith({ args: ['--approval-mode', 'yolo'], profile: null })
    // The pane binds to herdr's session file (sent out on its next flush).
    vi.advanceTimersByTime(16)
    expect(
      batches
        .flatMap((b) => b.ops)
        .some((o) => o.op === 'meta' && o.patch.sessionFile === herdrFile),
    ).toBe(true)
    expect(relay.commands).toEqual([])
    expect(shown()).toEqual(['user:hello herdr?', 'user:and then?', `notice:${STARTING_TEXT}`])

    // omp joins Relay: subscribed, then both prompts go, in order.
    relay.set([{ id: 'new', status: 'idle' }])
    await vi.advanceTimersByTimeAsync(0)
    expect(relay.log).toEqual(['subscribe new', 'cmd agent.reply', 'cmd agent.reply'])
    expect(relay.commands).toEqual([
      { kind: 'agent.reply', sessionId: 'new', text: `${TAG}hello herdr`, submit: true },
      { kind: 'agent.reply', sessionId: 'new', text: `${TAG}and then`, submit: true },
    ])
    expect(shown()).toEqual(['user:hello herdr?', 'user:and then?'])
    write(herdrFile, [user('u1', 'hello herdr'), user('u2', 'and then'), reply('a1', 'Hi!')])
    expect(shown()).toEqual(['user:hello herdr', 'user:and then', 'assistant:Hi!'])
    expect(transports).toEqual([])
  })

  it('falls back to a local omp when herdr or Relay is unavailable, and says why', async () => {
    const noHerdr = setup()
    noHerdr.relay.set([])
    noHerdr.mgr.openDraft('pane-1', meta)
    await noHerdr.mgr.send('pane-1', 'hi')
    expect(noHerdr.transports).toHaveLength(1)
    expect(noHerdr.logs).toEqual(["New chat starts as a local omp: herdr isn't available."])

    const herdr = vi.fn(async () => herdrFile)
    const relayDown = setup({ herdr })
    relayDown.mgr.openDraft('pane-1', meta)
    await relayDown.mgr.send('pane-1', 'hi')
    expect(herdr).not.toHaveBeenCalled()
    expect(relayDown.transports).toHaveLength(1)
    expect(relayDown.logs).toEqual(["New chat starts as a local omp: Relay isn't connected."])

    // The Claude harness keeps its own path.
    const claude = setup({ herdr, harness: () => 'claude' })
    claude.relay.set([])
    claude.mgr.openDraft('pane-1', meta)
    await claude.mgr.send('pane-1', 'hi')
    expect(herdr).not.toHaveBeenCalled()
    expect(claude.transports).toHaveLength(1)
    expect(claude.logs).toEqual([])
  })

  it('gives the prompt back with the reason when herdr fails to start omp', async () => {
    const { mgr, relay, shown, transports } = setup({
      herdr: async () => {
        throw new Error('herdr: no server running')
      },
    })
    relay.set([])
    mgr.openDraft('pane-1', meta)
    await expect(mgr.send('pane-1', 'hello')).rejects.toMatchObject({
      code: 'herdr-failed',
      message: "Couldn't start omp in herdr: herdr: no server running",
    })
    expect(shown()).toEqual([])
    expect(mgr.snapshot('pane-1').away).toBeNull()
    expect(mgr.launchState('pane-1').unsent).toBe(true)
    expect(transports).toEqual([])
  })
})

describe('SessionManager in remote mode: every chat runs on the Mini', () => {
  const miniFile = '/m/2026_new.jsonl'
  it('starts a new chat on the Mini, sends its prompt once omp joins and binds to its file', async () => {
    const { promise, resolve } = Promise.withResolvers<string>()
    const start = vi.fn(() => promise)
    const herdr = vi.fn(async () => '/s/x.jsonl')
    const { mgr, relay, write, shown, transports, batches } = setup({ mini: { start }, herdr })
    relay.set([])
    mgr.openDraft('pane-1', meta)
    const sending = mgr.send('pane-1', 'hello mini')
    expect(shown()).toEqual(['user:hello mini?', `notice:${MINI_STARTING_TEXT}`])
    resolve('new')
    await sending
    expect(start).toHaveBeenCalledWith({ profile: null })
    expect(relay.commands).toEqual([])
    relay.set([{ id: 'new', status: 'idle' }])
    await vi.advanceTimersByTimeAsync(0)
    expect(relay.commands).toEqual([
      { kind: 'agent.reply', sessionId: 'new', text: `${TAG}hello mini`, submit: true },
    ])
    // The mirror writes the Mini's file: the pane binds to it and shows it.
    write(miniFile, [user('u1', 'hello mini'), reply('a1', 'Hi!')])
    expect(shown()).toEqual(['user:hello mini', 'assistant:Hi!'])
    vi.advanceTimersByTime(16)
    expect(
      batches.flatMap((b) => b.ops).some((o) => o.op === 'meta' && o.patch.sessionFile === miniFile),
    ).toBe(true)
    expect(herdr).not.toHaveBeenCalled()
    expect(transports).toEqual([])
  })
  it('resumes a past chat on the Mini, then sends the reply', async () => {
    const start = vi.fn(async () => 'out')
    const { mgr, relay, shown, transports } = setup({ mini: { start } })
    relay.set([])
    mgr.open('pane-1', FILE, [user('u1', 'hi')], meta)
    await mgr.send('pane-1', 'again')
    expect(start).toHaveBeenCalledWith({ resume: 'out', profile: null })
    expect(shown()).toEqual(['user:hi', 'user:again?', `notice:${MINI_STARTING_TEXT}`])
    relay.set([{ id: 'out', status: 'idle' }])
    await vi.advanceTimersByTimeAsync(0)
    expect(relay.commands).toEqual([
      { kind: 'agent.reply', sessionId: 'out', text: `${TAG}again`, submit: true },
    ])
    expect(transports).toEqual([])
  })
  it('refuses what would need a local omp: an unreachable chat, a /goal chat, Relay down', async () => {
    const start = vi.fn(async () => 'x')
    const { mgr, relay, transports } = setup({ mini: { start } })
    relay.set([{ id: 'out', canRespond: false }])
    mgr.open('pane-1', FILE, [], meta)
    await expect(mgr.send('pane-1', 'hi', { force: true })).rejects.toThrow(MINI_CANT_REACH)
    mgr.openDraft('pane-2', meta)
    await expect(mgr.send('pane-2', '/goal ship it')).rejects.toThrow(MINI_GOAL)
    relay.set(null)
    await expect(mgr.send('pane-2', 'hi')).rejects.toThrow(MINI_DOWN)
    expect(start).not.toHaveBeenCalled()
    expect(transports).toEqual([])
  })
  it('refuses a destructive approval and approves others without vouching for them (Q6)', async () => {
    const { mgr, relay } = setup({ mini: { start: vi.fn() } })
    relay.set([{ id: 'out', status: 'needs_permission', detail: 'bash' }])
    mgr.open('pane-1', FILE, [], meta)
    const approval = (id: string, destructive: string | null) =>
      relay.emit({
        kind: 'approval',
        session: 'out',
        approval: { id, tool: 'bash', command: 'ls', reason: null, destructive },
      })
    approval('c1', 'rm -rf')
    await expect(
      mgr.answerUi('pane-1', 'approval:c1', { kind: 'confirm', confirmed: true }),
    ).rejects.toThrow(APPROVE_ON_PHONE)
    approval('c2', null)
    await mgr.answerUi('pane-1', 'approval:c2', { kind: 'confirm', confirmed: true })
    expect(relay.commands).toEqual([
      { kind: 'agent.approve', sessionId: 'out', approvalId: 'c2' },
    ])
  })
})
