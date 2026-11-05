import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionOwners } from './owners'

const write = (root: string, agent: string, body: unknown): void => {
  const dir = path.join(root, 'work/eva/agents', agent)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(body))
}

describe('SessionOwners', () => {
  it('maps each registered session id to its assistant, closed when closedAt is set', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owners-'))
    write(root, 'astra', [
      { id: 'x', sessionFile: '/s/2026-10-29T13-17-26-386Z_aaa.jsonl', title: 'ENG-1 auto-work' },
      {
        id: 'y',
        sessionFile: '/s/2026-10-29T13-22-27-255Z_bbb.jsonl',
        title: 'ENG-2 auto-work',
        closedAt: '2026-10-29T14:00:00Z',
      },
    ])
    write(root, 'nova', [{ sessionFile: '/s/2026_ccc.jsonl' }])
    fs.mkdirSync(path.join(root, 'work/eva/agents/polaris'))
    const owners = new SessionOwners(root)
    expect(Object.fromEntries(owners.current())).toEqual({
      aaa: { agent: 'astra', closed: false },
      bbb: { agent: 'astra', closed: true },
      ccc: { agent: 'nova', closed: false },
    })
    // A broken file drops only that assistant's sessions.
    fs.writeFileSync(path.join(root, 'work/eva/agents/nova/sessions.json'), '[{')
    expect([...owners.current().keys()]).toEqual(['aaa', 'bbb'])
  })

  it('finds a registered session transcript wherever it sits, by id or by path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owners-'))
    const project = path.join(root, 'sessions/-Eva-work-relay')
    fs.mkdirSync(project, { recursive: true })
    const file = path.join(project, '2026-11-05T17-41-57-942Z_01a1accd-9a36.jsonl')
    fs.writeFileSync(file, '')
    write(root, 'nova', [
      {
        sessionFile: file,
        title: 'Per-chat isolated pane layouts',
        closedAt: '2026-11-05T18:00:00Z',
      },
    ])
    const owners = new SessionOwners(root)
    expect(owners.fileOf('01a1accd-9a36')).toEqual({
      file,
      title: 'Per-chat isolated pane layouts',
      agent: 'nova',
      closed: true,
    })
    expect(owners.fileOf('nope')).toBeNull()
    expect(owners.owns(file)).toBe(true)
    // A file next to it that nobody registered is not an owned transcript.
    const other = path.join(project, '2026-11-05T17-41-57-942Z_other.jsonl')
    fs.writeFileSync(other, '')
    expect(owners.owns(other)).toBe(false)
    // A symlink to a registered file is the same file.
    const link = path.join(root, 'link.jsonl')
    fs.symlinkSync(file, link)
    expect(owners.owns(link)).toBe(true)
  })

  it('no agents dir means no owners', () => {
    expect(new SessionOwners('/nonexistent').current().size).toBe(0)
  })
})
