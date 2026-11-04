import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
/** main's events the store subscribed to, by channel. */
const handlers = new Map<string, (payload: unknown) => void>()
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: (channel: string, cb: (payload: unknown) => void) => {
    handlers.set(channel, cb)
    return () => handlers.delete(channel)
  },
}))
vi.mock('../tiling/recent', () => ({ recordFile: () => undefined }))

import type { PresenceEdit } from '@evaos/contract'
import { changedRanges } from '@relay/protocol/text-diff'
import { lineEdits, rebase, type TextEdit } from './buffer-edits'
import {
  applyAgentEdit,
  followChat,
  filesStore,
  openFile,
  resetFilesStoreForTests,
  setDirty,
  setEditorBridge,
  startFiles,
} from './files-store'
import {
  AGENT_LINGER_MS,
  editorFocus,
  markKey,
  presenceStore,
  resetPresenceForTests,
  setLocalFocus,
} from './presence-store'

const ROOT = '/eva'
const FILE = 'notes.md'
const BASE = ['# Notes', 'one', 'two', 'three', 'four', 'five', ''].join('\n')
const NOVA = { name: 'Nova', color: '#12b886' }

/** A disk version's identity (main's is a sha1; any one-to-one stand-in does here). */
const hashOf = (text: string): string => `v:${text}`
const version = (text: string) => ({ mtimeMs: 1, size: text.length, hash: hashOf(text) })

/** What is on disk now (files.read answers it). */
let disk = BASE
/** The editor buffer, as the Monaco bridge keeps it: its text and whether it is saved. */
let buffer = { text: BASE, clean: true }

function apply(text: string, edits: readonly TextEdit[]): string {
  let out = text
  for (const e of [...edits].reverse()) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

function tab() {
  return filesStore.getState().spaces[ROOT]?.tabs.find((t) => t.path === FILE)
}

/** An agent's write as the host reports it: the disk changes, then `files.edit` arrives. */
function agentWrites(text: string): PresenceEdit {
  const before = disk
  disk = text
  const ranges = changedRanges(before, text)
  return {
    targets: [{ root: ROOT, path: FILE }],
    hash: hashOf(text),
    ranges,
    caret: { line: ranges.at(-1)?.endLine ?? 1, column: 1 },
    agent: NOVA,
    intent: 'Tidying the notes',
    at: Date.now(),
  }
}

let stop: () => void
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  resetFilesStoreForTests()
  resetPresenceForTests()
  disk = BASE
  buffer = { text: BASE, clean: true }
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'files.root') return { ok: true, value: { root: ROOT, name: 'Eva' } }
    if (channel === 'files.list') return { ok: true, value: { entries: [] } }
    if (channel === 'files.read') {
      return { ok: true, value: { kind: 'text', text: disk, version: version(disk) } }
    }
    return { ok: true, value: {} }
  })
  // The Monaco bridge over a string buffer, with CodeEditor's rule (rebase) and edits.
  setEditorBridge({
    text: () => buffer.text,
    markClean: () => {
      buffer.clean = true
    },
    sync: (_root, _path, base, next) => {
      const r = rebase(buffer.text, buffer.clean, base, next)
      if (!r.ok) return r
      const ours = buffer.text
      buffer = { text: apply(ours, lineEdits(ours, r.text)), clean: !r.dirty }
      return { ok: true, ranges: changedRanges(ours, r.text), dirty: r.dirty }
    },
  })
  stop = startFiles()
  await followChat(null)
  openFile(ROOT, FILE, { pin: true })
  await vi.waitFor(() => expect(tab()?.content?.kind).toBe('text'))
})
afterEach(() => {
  stop()
  setEditorBridge(null)
  vi.useRealTimers()
})

function typeInBuffer(text: string): void {
  buffer = { text, clean: false }
  setDirty(ROOT, FILE, true)
}

describe('an agent edit in an open file', () => {
  it('lands in a clean buffer in place, with no banner, and shows the agent on the changed lines', async () => {
    const next = BASE.replace('two', 'two, now longer')
    await applyAgentEdit(agentWrites(next))
    expect(buffer).toEqual({ text: next, clean: true })
    expect(tab()).toMatchObject({ dirty: false, conflict: false, version: version(next) })
    const marks = presenceStore.getState().marks[markKey(ROOT, FILE)]
    expect(marks).toMatchObject([
      {
        agent: NOVA,
        ranges: [{ startLine: 3, endLine: 3 }],
        intent: 'Tidying the notes',
        fading: false,
      },
    ])
    vi.advanceTimersByTime(AGENT_LINGER_MS - 600)
    expect(presenceStore.getState().marks[markKey(ROOT, FILE)]?.[0]?.fading).toBe(true)
    vi.advanceTimersByTime(600)
    expect(presenceStore.getState().marks[markKey(ROOT, FILE)]).toBeUndefined()
  })

  it('merges into unsaved typing on other lines: both stay, still unsaved, saveable over the new version', async () => {
    typeInBuffer(BASE.replace('one', 'one (Isaac typing)'))
    const next = BASE.replace('four', 'FOUR')
    await applyAgentEdit(agentWrites(next))
    expect(buffer).toEqual({
      text: BASE.replace('one', 'one (Isaac typing)').replace('four', 'FOUR'),
      clean: false,
    })
    expect(tab()).toMatchObject({ dirty: true, conflict: false, version: version(next) })
    // The highlight is on the buffer's line, even after Isaac's own lines moved it.
    expect(presenceStore.getState().marks[markKey(ROOT, FILE)]?.[0]?.ranges).toEqual([
      { startLine: 5, endLine: 5 },
    ])
  })

  it('never overwrites typing on the same lines: the buffer stays and the banner names the agent', async () => {
    const mine = BASE.replace('two', 'two by Isaac')
    typeInBuffer(mine)
    await applyAgentEdit(agentWrites(BASE.replace('two', 'two by Nova')))
    expect(buffer).toEqual({ text: mine, clean: false })
    expect(tab()).toMatchObject({
      dirty: true,
      conflict: true,
      conflictBy: 'Nova',
      version: version(BASE),
    })
    expect(presenceStore.getState().marks[markKey(ROOT, FILE)]).toBeUndefined()
  })

  it('takes the write in once when the local watcher heard it first, and still shows whose it was', async () => {
    const next = BASE.replace('five', 'five\nsix')
    const edit = agentWrites(next)
    // main's own watcher heard the write before the host's frame came.
    handlers.get('files.changed')?.({ root: ROOT, paths: [FILE] })
    await vi.waitFor(() => expect(buffer.text).toBe(next))
    const reads = invoke.mock.calls.filter((c) => c[0] === 'files.read').length
    await applyAgentEdit(edit)
    expect(invoke.mock.calls.filter((c) => c[0] === 'files.read').length).toBe(reads)
    expect(presenceStore.getState().marks[markKey(ROOT, FILE)]).toMatchObject([
      { agent: NOVA, ranges: [{ startLine: 7, endLine: 7 }] },
    ])
    expect(tab()).toMatchObject({ dirty: false, conflict: false, version: version(next) })
  })

  it('tells main which tabs are open, so the host watches them', async () => {
    vi.advanceTimersByTime(150)
    expect(invoke).toHaveBeenCalledWith('files.presence.open', {
      files: [{ root: ROOT, path: FILE }],
    })
  })
})

describe("Isaac's caret", () => {
  it('goes to main throttled and is what describe reports, unless another device moved later', () => {
    setLocalFocus({ root: ROOT, path: FILE, caret: { line: 2, column: 3 } })
    setLocalFocus({ root: ROOT, path: FILE, caret: { line: 3, column: 1 } })
    setLocalFocus({ root: ROOT, path: FILE, caret: { line: 4, column: 1 } })
    const sent = () =>
      invoke.mock.calls.filter((c) => c[0] === 'files.presence.caret').map((c) => c[1])
    expect(sent()).toEqual([{ focus: { root: ROOT, path: FILE, caret: { line: 2, column: 3 } } }])
    vi.advanceTimersByTime(250)
    expect(sent().at(-1)).toEqual({
      focus: { root: ROOT, path: FILE, caret: { line: 4, column: 1 } },
    })
    expect(editorFocus()).toMatchObject({ file: '/eva/notes.md', line: 4, column: 1, device: null })
    vi.advanceTimersByTime(1000)
    presenceStore.setState({
      remote: [
        {
          device: 'mbp',
          deviceName: "Isaac's MacBook Pro",
          path: '/Users/ike/Eva/memory/prime.md',
          caret: { line: 9, column: 2 },
          selection: { start: { line: 9, column: 2 }, end: { line: 10, column: 1 } },
          selectedText: 'x\n',
          at: Date.now(),
        },
      ],
    })
    expect(editorFocus()).toEqual({
      file: '/Users/ike/Eva/memory/prime.md',
      line: 9,
      column: 2,
      selection: { start: { line: 9, column: 2 }, end: { line: 10, column: 1 } },
      selectedText: 'x\n',
      device: "Isaac's MacBook Pro",
      at: Date.now(),
    })
  })
})
