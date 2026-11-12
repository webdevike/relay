import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentNote } from '@evaos/contract'
import { createSendNote, noteOwner } from './notes'

const comment = (assignee?: string): AgentNote => ({
  surface: 'canvas',
  text: 'Make this bigger',
  slug: 'mind-map',
  board: 'Q4 roadmap',
  page: 'page-1',
  thread: 't-1',
  node: { id: 'note-3', title: 'Launch' },
  at: { x: 10, y: 20 },
  reply: false,
  ...(assignee === undefined ? {} : { assignee }),
})

const known = (id: string): boolean => id === 'penny'

describe('note owner', () => {
  it('sends a comment that @mentions an assistant to its thread, over the run', () => {
    expect(noteOwner(comment('penny'), 'chat:/s/b.jsonl', 'chat:/s/a.jsonl', known)).toEqual({
      assistant: 'penny',
    })
  })

  it('sends to the chat whose agent works the board, not the one it is shown in', () => {
    expect(noteOwner(comment('stranger'), 'chat:/s/b.jsonl', 'chat:/s/a.jsonl', known)).toEqual({
      file: '/s/a.jsonl',
    })
  })

  it('falls back to the chat of the workspace, and to no one on a plain page', () => {
    expect(noteOwner(comment(), 'page:agent:nova', null, known)).toEqual({ assistant: 'nova' })
    expect(noteOwner(comment(), 'page:canvas', null, known)).toBeNull()
    expect(noteOwner(comment(), null, null, known)).toBeNull()
  })
})

describe('send note', () => {
  it("attaches every marked element's screenshot in order and skips a missing one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'))
    const png = (n: number): string => {
      const f = path.join(dir, `${n}.png`)
      fs.writeFileSync(f, `png-${n}`)
      return f
    }
    const region = { x: 0, y: 0, w: 10, h: 10 }
    const note: AgentNote = {
      surface: 'browser',
      intent: 'change',
      text: 'Tighter',
      url: 'http://localhost:5173/',
      title: 'App',
      tabId: 't1',
      region,
      image: png(0),
      also: [
        { region, image: path.join(dir, 'gone.png') },
        ...[1, 2, 3, 4, 5, 6].map((n) => ({ region, image: png(n) })),
      ],
    }
    const posts: Array<{ text: string; images: ReadonlyArray<{ data: string }> }> = []
    const send = createSendNote({
      chat: {
        post: async (_owner, text, images) => {
          posts.push({ text, images: images ?? [] })
          return 'Chat'
        },
        assistants: () => ({ agents: [] }) as never,
      },
      runWorkspace: () => null,
    })
    expect(await send(note, 'chat:/s/a.jsonl')).toEqual({ sent: true, to: 'Chat' })
    const data = posts[0]!.images.map((i) => Buffer.from(i.data, 'base64').toString())
    // Offered in order: 0, gone, 1..6; the gone one drops out (its path stays in the text).
    expect(data).toEqual(['png-0', 'png-1', 'png-2', 'png-3', 'png-4', 'png-5', 'png-6'])
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
