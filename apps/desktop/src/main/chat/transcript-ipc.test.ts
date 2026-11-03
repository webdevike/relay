import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  ipcMain: {},
  BaseWindow: class {},
  WebContentsView: class {},
}))

import { resolveInsideSessionsDir, resolveSubagentTranscript } from './transcript-ipc'

let root: string
let sessions: string
let session: string
let sub: string
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-tr-')))
  sessions = path.join(root, 'sessions')
  fs.mkdirSync(path.join(sessions, 'chat'), { recursive: true })
  session = path.join(sessions, 'chat.jsonl')
  sub = path.join(sessions, 'chat', '0-Scout.jsonl')
  fs.writeFileSync(session, '')
  fs.writeFileSync(sub, '')
})

describe('resolveSubagentTranscript', () => {
  it('accepts a subagent .jsonl inside a session folder', () => {
    expect(resolveSubagentTranscript([sessions], sub)).toBe(sub)
  })

  it('rejects a top-level session, a file outside, a non-jsonl and a folder', () => {
    const outside = path.join(root, 'x.jsonl')
    fs.writeFileSync(outside, '')
    const txt = path.join(sessions, 'chat', 'notes.txt')
    fs.writeFileSync(txt, '')
    const dir = path.join(sessions, 'chat', 'nested.jsonl')
    fs.mkdirSync(dir)
    for (const f of [session, outside, txt, dir, path.join(sessions, 'chat', 'gone.jsonl')]) {
      expect(() => resolveSubagentTranscript([sessions], f)).toThrow()
    }
  })

  it('rejects a symlink in the session folder that points outside', () => {
    const outside = path.join(root, 'secret.jsonl')
    fs.writeFileSync(outside, '')
    const link = path.join(sessions, 'chat', 'link.jsonl')
    fs.symlinkSync(outside, link)
    expect(() => resolveSubagentTranscript([sessions], link)).toThrow()
  })
})

describe('resolveInsideSessionsDir', () => {
  it('still accepts top-level sessions only', () => {
    expect(resolveInsideSessionsDir([sessions], session)).toBe(session)
    expect(() => resolveInsideSessionsDir([sessions], sub)).toThrow()
  })
})
