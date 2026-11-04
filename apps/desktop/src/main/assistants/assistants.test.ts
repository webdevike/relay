import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RelaySession, RelayStatus } from '../relay/feed'
import {
  assistantIdFrom,
  AssistantsService,
  REGISTRY_FILE,
  lastReply,
  parseRegistry,
  readTail,
} from './assistants'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const rec = (o: unknown): string => JSON.stringify(o)
const reply = (content: unknown, timestamp = '2026-10-23T10:00:00.000Z'): string =>
  rec({ type: 'message', timestamp, message: { role: 'assistant', content } })
const user = (text: string): string =>
  rec({
    type: 'message',
    timestamp: '2026-10-23T09:00:00.000Z',
    message: { role: 'user', content: text },
  })

function thread(id: string, agent: string, status: RelayStatus): RelaySession {
  return {
    id,
    status,
    detail: null,
    canRespond: true,
    kind: 'assistant',
    title: '',
    assistant: agent,
    activity: null,
    activityAt: null,
  }
}

/** An Eva root with the registry and a sessions dir; Relay reads `relay.sessions`. */
function setup(
  agents: unknown[] = [
    { id: 'astra', title: 'Astra', scope: 'eCard Systems work', avatar: 'astra-2' },
    { id: 'nova', title: 'Nova' },
  ],
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistants-'))
  dirs.push(root)
  fs.mkdirSync(path.join(root, '.omp/assistant'), { recursive: true })
  fs.writeFileSync(path.join(root, REGISTRY_FILE), JSON.stringify({ agents }))
  const sessionsDir = path.join(root, 'sessions')
  fs.mkdirSync(sessionsDir)
  const relay: { sessions: Map<string, RelaySession> | null } = { sessions: new Map() }
  const svc = new AssistantsService({
    evaRoot: root,
    sessionsDirs: [sessionsDir],
    relay: () => relay.sessions,
  })
  const write = (id: string, lines: string[]): string => {
    const file = path.join(sessionsDir, `2026-10-23T08-00-00-000Z_${id}.jsonl`)
    fs.writeFileSync(file, lines.join('\n') + '\n')
    return file
  }
  return { root, svc, relay, write }
}

describe('assistant status like native', () => {
  it('reads each agent from the Relay session tagged with its id', () => {
    const s = setup([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
      { id: 'd', title: 'D' },
      { id: 'e', title: 'E' },
      { id: 'f', title: 'F' },
      { id: 'g', title: 'G' },
      { id: 'h', title: 'H' },
    ])
    s.relay.sessions = new Map(
      [
        thread('s-a', 'a', 'working'),
        thread('s-b', 'b', 'waiting'),
        thread('s-c', 'c', 'needs_permission'),
        thread('s-d', 'd', 'idle'),
        thread('s-e', 'e', 'ended'),
        // A hand-started chat that happens to name an agent is not its thread.
        { ...thread('s-f', 'f', 'working'), kind: 'manual' as const },
        // omp's ask tool blocks while Relay still says working: it waits on Isaac.
        { ...thread('s-g', 'g', 'working'), detail: 'ask' },
        { ...thread('s-h', 'h', 'working'), detail: 'bash' },
      ].map((t) => [t.id, t]),
    )
    expect(s.svc.list().agents.map((a) => [a.id, a.status, a.tool])).toEqual([
      ['a', 'working', null],
      ['b', 'needs-you', null],
      ['c', 'needs-you', null],
      ['d', 'idle', null],
      ['e', 'idle', null],
      ['f', 'not-started', null],
      ['g', 'needs-you', null],
      // While it works, Relay's detail names the running tool.
      ['h', 'working', 'bash'],
    ])
  })

  it('says Not started, with no file and no preview, while Relay is down', () => {
    const s = setup()
    s.write('s-astra', [reply('Done.')])
    s.relay.sessions = null
    expect(s.svc.list()).toEqual({
      relayUp: false,
      agents: [
        {
          id: 'astra',
          title: 'Astra',
          scope: 'eCard Systems work',
          avatar: { style: 'notionists', seed: 'astra-2' },
          status: 'not-started',
          tool: null,
          file: null,
          reply: null,
        },
        {
          id: 'nova',
          title: 'Nova',
          scope: '',
          avatar: { style: 'notionists', seed: 'nova' },
          status: 'not-started',
          tool: null,
          file: null,
          reply: null,
        },
      ],
    })
  })

  it("previews a started thread's newest reply from its session file", () => {
    const s = setup()
    const file = s.write('s-astra', [
      user('hi'),
      reply([{ type: 'text', text: 'First   reply\nover lines' }], '2026-10-23T10:00:00.000Z'),
      reply([{ type: 'text', text: 'Pushed the fix.' }], '2026-10-23T11:00:00.000Z'),
    ])
    s.relay.sessions = new Map([['s-astra', thread('s-astra', 'astra', 'idle')]])
    const [astra, nova] = s.svc.list().agents
    expect(astra).toMatchObject({
      status: 'idle',
      file,
      reply: { text: 'Pushed the fix.', at: Date.parse('2026-10-23T11:00:00.000Z') },
    })
    // Relay lists no thread for Nova yet: its page is the start card.
    expect(nova).toMatchObject({ status: 'not-started', file: null, reply: null })
  })

  it('follows the file as omp appends a newer reply', () => {
    const s = setup()
    const file = s.write('s-astra', [reply('Old.')])
    s.relay.sessions = new Map([['s-astra', thread('s-astra', 'astra', 'working')]])
    expect(s.svc.list().agents[0]!.reply?.text).toBe('Old.')
    fs.appendFileSync(file, reply('New and longer.', '2026-10-23T12:00:00.000Z') + '\n')
    expect(s.svc.list().agents[0]!.reply?.text).toBe('New and longer.')
  })

  it('rereads the registry when its file changes', () => {
    const s = setup([{ id: 'astra', title: 'Astra' }])
    expect(s.svc.list().agents.map((a) => a.title)).toEqual(['Astra'])
    const file = path.join(s.root, REGISTRY_FILE)
    fs.writeFileSync(file, JSON.stringify({ agents: [{ id: 'polaris', title: 'Polaris' }] }))
    const later = Date.now() / 1000 + 5
    fs.utimesSync(file, later, later)
    expect(s.svc.list().agents.map((a) => a.title)).toEqual(['Polaris'])
  })
})

describe('last reply', () => {
  it('skips tool-only turns, thinking and user messages for the newest text', () => {
    const tail = [
      reply([{ type: 'text', text: 'The answer is 4.' }]),
      user('thanks'),
      reply([
        { type: 'thinking', thinking: 'hmm' },
        { type: 'toolCall', name: 'bash', arguments: {} },
      ]),
      '{"type":"message","message":{"role":"assistant"', // a line omp is still writing
    ].join('\n')
    expect(lastReply(tail)).toEqual({
      text: 'The answer is 4.',
      at: Date.parse('2026-10-23T10:00:00.000Z'),
    })
  })

  it('skips background replies of (nothing to report)', () => {
    const tail = [
      reply([{ type: 'text', text: 'ENG-6409 needs review.' }]),
      user("[From Astra's background jobs] Heartbeat"),
      reply([{ type: 'text', text: '(nothing to report)' }], '2026-10-24T10:00:00.000Z'),
    ].join('\n')
    expect(lastReply(tail)?.text).toBe('ENG-6409 needs review.')
  })

  it('joins text blocks on one line, clips long ones and keeps no time when none is readable', () => {
    const long = 'word '.repeat(100)
    const r = lastReply(
      rec({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: long },
          ],
        },
      }),
    )
    expect(r?.at).toBeNull()
    expect(Array.from(r!.text)).toHaveLength(200)
    expect(r!.text.startsWith('a word word')).toBe(true)
    expect(r!.text.endsWith('…')).toBe(true)
  })

  it('has none for a thread with no reply yet', () => {
    expect(lastReply(user('hi'))).toBeNull()
    expect(lastReply('')).toBeNull()
  })

  it('reads only the end of a long file, from its first whole line', () => {
    const s = setup()
    const file = s.write('big', [reply('x'.repeat(50)), reply('Last.')])
    const tail = readTail(file, reply('Last.').length + 10)!
    expect(tail).toBe(reply('Last.') + '\n')
  })
})

describe('registry', () => {
  it("makes a new assistant's id the way Relay Host does", () => {
    expect(assistantIdFrom('Vega')).toBe('vega')
    expect(assistantIdFrom('  Drive Buddy! ')).toBe('drive-buddy')
    expect(assistantIdFrom('Zoë')).toBe('zoe')
    expect(assistantIdFrom('4x4')).toBe('a-4x4')
    expect(assistantIdFrom('!!!')).toBe('')
  })

  it('keeps file order, gives an absent scope as empty and drops entries without an id', () => {
    expect(
      parseRegistry(
        JSON.stringify({
          agents: [
            { id: 'astra', title: 'Astra', scope: 'Work', model: 'x' },
            { title: 'No id' },
            { id: 'nova', title: 'Nova' },
          ],
        }),
      ),
    ).toEqual([
      {
        id: 'astra',
        title: 'Astra',
        scope: 'Work',
        avatar: { style: 'notionists', seed: 'astra' },
      },
      { id: 'nova', title: 'Nova', scope: '', avatar: { style: 'notionists', seed: 'nova' } },
    ])
  })

  it("takes an agent's portrait: designed, else a seed, else its id when absent, blank or unreadable", () => {
    const nova = {
      style: 'micah',
      seed: 'nova-17',
      options: { glasses: ['round'], glassesProbability: 100 },
      colors: { paper: '#e7f5ff', accent: '#f76707' },
    }
    expect(
      parseRegistry(
        JSON.stringify({
          agents: [
            { id: 'astra', title: 'Astra', avatar: 'astra-2' },
            { id: 'nova', title: 'Nova', avatar: nova },
            { id: 'blank', title: 'Blank', avatar: '  ' },
            { id: 'polaris', title: 'Polaris', avatar: 11 },
            { id: 'pixel', title: 'Pixel', avatar: { style: 'pixel-art', seed: 'x' } },
            { id: 'vega', title: 'Vega' },
          ],
        }),
      ).map((a) => [a.id, a.avatar]),
    ).toEqual([
      ['astra', { style: 'notionists', seed: 'astra-2' }],
      ['nova', nova],
      ['blank', { style: 'notionists', seed: 'blank' }],
      ['polaris', { style: 'notionists', seed: 'polaris' }],
      ['pixel', { style: 'notionists', seed: 'pixel' }],
      ['vega', { style: 'notionists', seed: 'vega' }],
    ])
  })

  it('is empty when missing or unreadable', () => {
    expect(parseRegistry('not json')).toEqual([])
    expect(parseRegistry('{}')).toEqual([])
    const s = setup()
    fs.rmSync(path.join(s.root, REGISTRY_FILE))
    expect(s.svc.list().agents).toEqual([])
  })
})
