import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
}))
vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) =>
      ipc.handlers.set(channel, fn),
  },
}))
vi.mock('../window', () => ({ isAppUrl: () => true }))

type StartOpts = {
  sessionFile: string | null
  args?: readonly string[]
  env?: Record<string, string | undefined>
}
const omp = vi.hoisted(() => ({
  starts: [] as StartOpts[],
  sends: [] as string[],
  frames: [] as Array<(f: Record<string, unknown>) => void>,
}))
vi.mock('../chat/omp-transport', () => ({
  OmpStdioTransport: class {
    onFrame(cb: (f: Record<string, unknown>) => void): () => void {
      omp.frames.push(cb)
      return () => undefined
    }
    start(opts: StartOpts): Promise<void> {
      omp.starts.push(opts)
      return Promise.resolve()
    }
    write(): Promise<void> {
      return Promise.resolve()
    }
    send(text: string): Promise<void> {
      omp.sends.push(text)
      return Promise.resolve()
    }
    close(): Promise<void> {
      return Promise.resolve()
    }
    abort(): Promise<void> {
      return Promise.resolve()
    }
  },
}))

import { createConfigStore } from '../config-store'
import type { MainContext } from '../context'
import { ITEM_SESSION_TOOLS, registerAstraSessions } from './astra-sessions'

const PR = 'https://github.com/o/r/pull/1'
let dir: string

beforeEach(() => {
  ipc.handlers.clear()
  omp.starts.length = 0
  omp.sends.length = 0
  omp.frames.length = 0
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-sessions-'))
  const root = path.join(dir, 'eva')
  const agents = path.join(root, '.omp', 'assistant', 'agents')
  for (const id of ['astra', 'nova']) {
    fs.mkdirSync(path.join(agents, id), { recursive: true })
    fs.writeFileSync(path.join(agents, id, 'prime.md'), `You are ${id}.`)
  }
  fs.writeFileSync(
    path.join(root, '.omp', 'assistant', 'agents.json'),
    JSON.stringify({
      agents: [
        { id: 'astra', title: 'Astra' },
        { id: 'nova', title: 'Nova', model: 'gpt' },
      ],
    }),
  )
  const ctx = {
    config: createConfigStore(path.join(dir, 'config')),
    env: { evaRoot: root, ompBin: 'omp', live: false, agentDir: path.join(dir, 'agent') },
    shell: { webContents: { isDestroyed: () => false, send: () => undefined } },
    onBeforeQuit: () => undefined,
  } as unknown as MainContext
  registerAstraSessions(ctx)
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

async function call(
  channel: string,
  input: unknown,
): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> {
  return (await ipc.handlers.get(channel)!({ senderFrame: { url: 'app://shell' } }, input)) as never
}

function expectReadOnly(start: StartOpts | undefined): void {
  const gh = path.join(dir, 'config', 'reviews-assistant-gh')
  expect(start?.args).toContain(`--tools=${ITEM_SESSION_TOOLS}`)
  expect(start?.env).toEqual({
    LINEAR_API_KEY: undefined,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_CONFIG_DIR: gh,
  })
  expect(fs.readdirSync(gh)).toEqual([])
}

describe('item sessions per assistant', () => {
  it('gives Nova her own read-only session beside Astra’s and resumes it under the same rules', async () => {
    const ask = { url: PR, label: 'o/r#1', context: '### PR', text: 'safe?' }
    const astra = await call('reviews.astraAsk', ask)
    const nova = await call('reviews.astraAsk', { ...ask, agent: 'nova' })
    expect(astra.value).toMatchObject({ url: PR, title: 'Astra · o/r#1' })
    expect(astra.value).not.toHaveProperty('agent')
    expect(nova.value).toMatchObject({ url: PR, title: 'Nova · o/r#1', agent: 'nova' })
    expect(omp.starts).toHaveLength(2)
    expect(omp.starts[1]?.args).toEqual(expect.arrayContaining(['--model', 'gpt']))
    expect(omp.sends[1]?.startsWith('You are nova.')).toBe(true)
    expect(omp.sends[1]).toContain('every @Nova question')
    for (const start of omp.starts) expectReadOnly(start)

    // omp names Nova's file, then her process ends; the next ask resumes that file, read-only again.
    const file = path.join(dir, 'n1.jsonl')
    fs.writeFileSync(file, '')
    omp.frames[1]?.({ type: 'response', command: 'get_state', data: { sessionFile: file } })
    omp.frames[1]?.({ type: '_eof' })
    expect((await call('reviews.astraThread', { url: PR, agent: 'nova' })).value).toMatchObject({
      file,
      agent: 'nova',
    })
    expect((await call('reviews.astraThread', { url: PR })).value).toMatchObject({ file: null })
    await call('reviews.astraAsk', { ...ask, text: 'still there?', agent: 'nova' })
    expect(omp.starts).toHaveLength(3)
    expect(omp.starts[2]?.sessionFile).toBe(file)
    expect(omp.sends[2]).toBe('still there?')
    expectReadOnly(omp.starts[2])
    const store = JSON.parse(
      fs.readFileSync(path.join(dir, 'config', 'reviews-astra.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(Object.keys(store).sort()).toEqual([PR, `nova|${PR}`])
  })
})
