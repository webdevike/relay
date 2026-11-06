import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import {
  addHunk,
  docThreadsOf,
  openDocThread,
  rejectSuggestion,
  relPos,
  sliceRuns,
  textAnchor,
} from '@relay/canvas-live/doc-threads'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }))

import { SkillDocument, type Session } from './SkillEditor'

const ISAAC = { name: 'Isaac', color: '#0ea5e9', kind: 'human' as const }

/** A doc as the host would hold it: frontmatter, and a heading and paragraph in the body. */
function hostDoc(): { doc: Y.Doc; text: Y.XmlText } {
  const doc = new Y.Doc()
  doc.getMap('front').set('name', 'canvas')
  doc.getMap('front').set('description', 'Build and open boards.')
  const heading = new Y.XmlElement('heading')
  heading.setAttribute('level', 1 as unknown as string)
  heading.insert(0, [new Y.XmlText('Canvas boards')])
  const para = new Y.XmlElement('paragraph')
  const text = new Y.XmlText('A board is one JSON file.')
  para.insert(0, [text])
  doc.getXmlFragment('body').insert(0, [heading, para])
  return { doc, text }
}

function ui(doc: Y.Doc) {
  const awareness = new Awareness(doc)
  const session: Session = {
    doc,
    provider: { awareness } as unknown as WebsocketProvider,
    user: ISAAC,
  }
  render(
    <MantineProvider>
      <SkillDocument name="canvas" session={session} />
    </MantineProvider>,
  )
  return awareness
}

beforeEach(() => invoke.mockReset())

describe('SkillDocument', () => {
  it('renders the body and binds the frontmatter header to the doc', async () => {
    const { doc } = hostDoc()
    ui(doc)
    expect(await screen.findByRole('heading', { name: 'Canvas boards' })).toBeInTheDocument()
    expect(screen.getByText('A board is one JSON file.')).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('canvas')
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Boards.' } })
    expect(doc.getMap('front').get('description')).toBe('Boards.')
    act(() => doc.getMap('front').set('name', 'canvas-2'))
    expect(screen.getByLabelText('Name')).toHaveValue('canvas-2')
  })

  it('saves on Cmd+S and shows the banner when SKILL.md moved on disk', async () => {
    invoke.mockResolvedValue({ ok: true, value: { status: 'changed-on-disk' } })
    const { doc } = hostDoc()
    ui(doc)
    fireEvent.keyDown(await screen.findByTestId('skill-editor'), { key: 's', metaKey: true })
    expect(invoke).toHaveBeenCalledWith('skills.save', { name: 'canvas' })
    expect(await screen.findByTestId('skill-disk-changed')).toBeInTheDocument()

    invoke.mockResolvedValue({ ok: true, value: { status: 'saved' } })
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }))
    expect(invoke).toHaveBeenLastCalledWith('skills.save', { name: 'canvas', force: true })
    await waitFor(() => expect(screen.queryByTestId('skill-disk-changed')).toBeNull())
  })

  it("shows an agent's named caret where its awareness points", async () => {
    const { doc, text } = hostDoc()
    const awareness = ui(doc)
    await screen.findByRole('heading', { name: 'Canvas boards' })
    // Nova edits through the host: another client in the same room.
    const remote = new Awareness(new Y.Doc())
    const at = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 2)) as unknown
    remote.setLocalState({
      user: { name: 'Nova', color: '#f76707', kind: 'agent' },
      cursor: { anchor: at, head: at },
    })
    act(() => {
      applyAwarenessUpdate(awareness, encodeAwarenessUpdate(remote, [remote.clientID]), 'remote')
    })
    await waitFor(() =>
      expect(document.querySelector('.collaboration-carets__label')).toHaveTextContent('Nova'),
    )
  })

  it("highlights a comment's text and draws an agent's suggestion as an inline diff", async () => {
    const { doc, text } = hostDoc()
    ui(doc)
    await screen.findByRole('heading', { name: 'Canvas boards' })
    act(() => {
      openDocThread(docThreadsOf(doc), 't-1', textAnchor(text, 2, 5, 'board'), {
        id: 'm1',
        kind: 'human',
        name: 'Isaac',
        color: '#0ea5e9',
        text: 'Call it a canvas?',
        ts: 1,
      })
    })
    await waitFor(() =>
      expect(document.querySelector('[data-thread="t-1"]')).toHaveTextContent('board'),
    )
    // Nova answers with a change, as the host records it: the replaced run, then the typed one.
    act(() => {
      const removed = sliceRuns(text, 2, 7)
      text.delete(2, 5)
      text.insert(2, 'canvas', {})
      addHunk(
        doc,
        's-t-1',
        { thread: 't-1', by: { name: 'Nova', color: '#f76707' }, ts: 2 },
        { kind: 'text', from: relPos(text, 2), to: relPos(text, 8, -1), removed },
      )
    })
    await waitFor(() => expect(document.querySelector('.eva-doc-del')).toHaveTextContent('board'))
    expect(document.querySelector('.eva-doc-ins')).toHaveTextContent('canvas')
    act(() => {
      rejectSuggestion(doc, 's-t-1')
    })
    await waitFor(() => expect(document.querySelector('.eva-doc-del')).toBeNull())
    expect(document.querySelector('.eva-skills-prose p')).toHaveTextContent(
      'A board is one JSON file.',
    )
    // The thread is on the restored text again.
    expect(document.querySelector('[data-thread="t-1"]')).toHaveTextContent('board')
  })
})
