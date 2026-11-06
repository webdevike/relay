import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Textarea, TextInput } from '@mantine/core'
import { RichTextEditor } from '@mantine/tiptap'
import { notifications } from '@mantine/notifications'
import '@mantine/tiptap/styles.css'
import { useEditor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { Placeholder } from '@tiptap/extensions'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type { SkillUser } from '@evaos/contract'
import type { TextAnchor } from '@relay/canvas-live/doc-threads'
import { agentOf, assistantsStore } from '../assistants/assistants-store'
import { avatarAgent } from '../comments/ThreadParts'
import { invoke } from '../ipc'
import { portrait } from '../ui/portrait'
import { anchorOf, DocComments, redrawComments } from './doc-comments'
import { DocThreads } from './DocThreads'
import { skillSchemaExtensions } from './skill-schema'
import { SkillDocBar } from './SkillDocBar'
import { SkillToolbar } from './SkillToolbar'
import { useYMap } from './use-ymap'

/** An open skill: its live doc, the provider syncing it with the host, and who Isaac is in it. */
export interface Session {
  doc: Y.Doc
  provider: WebsocketProvider
  user: SkillUser
}

/** A remote selection, tinted in its owner's color (a valid `#rrggbb` only, as y-tiptap checks). */
function selectionRender(user: Record<string, unknown>): Record<string, string> {
  const color = typeof user['color'] === 'string' ? user['color'] : ''
  if (!/^#[0-9a-f]{6}$/i.test(color)) return {}
  return {
    nodeName: 'span',
    class: 'collaboration-carets__selection',
    style: `background-color: ${color}4d`,
  }
}

function failed(what: 'save' | 'reload', message: string): void {
  notifications.show({
    color: 'red',
    message: `Could not ${what} SKILL.md. ${message}`,
    autoClose: 8000,
  })
}

/**
 * Someone else's caret: a line in their color and a name tag, with the assistant's portrait when
 * the caret is a registry assistant's (agents editing through the host publish its avatar URL).
 */
function caretRender(user: Record<string, unknown>): HTMLElement {
  const color = typeof user['color'] === 'string' ? user['color'] : '#868e96'
  const name = typeof user['name'] === 'string' ? user['name'] : ''
  const caret = document.createElement('span')
  caret.className = 'collaboration-carets__caret'
  caret.style.borderColor = color
  const label = document.createElement('div')
  label.className = 'collaboration-carets__label'
  label.style.backgroundColor = color
  const id = avatarAgent(typeof user['avatar'] === 'string' ? user['avatar'] : undefined)
  const face = id === null ? null : (agentOf(assistantsStore.getState(), id)?.avatar ?? null)
  if (face !== null) {
    const img = document.createElement('img')
    img.className = 'collaboration-carets__avatar'
    img.src = portrait(face)
    img.alt = ''
    label.append(img)
  }
  label.append(document.createTextNode(name))
  caret.append(label)
  return caret
}

/** The frontmatter as a compact header: name and description, live on the doc's `front` map. */
function FrontHeader({ front }: { front: Y.Map<unknown> }) {
  const f = useYMap(front)
  const name = typeof f['name'] === 'string' ? f['name'] : ''
  const description = typeof f['description'] === 'string' ? f['description'] : ''
  return (
    <div className="eva-skills-front" data-testid="skill-front">
      <TextInput
        variant="unstyled"
        size="xs"
        aria-label="Name"
        styles={{
          input: { fontFamily: 'var(--mantine-font-family-monospace)', fontWeight: 600 },
        }}
        value={name}
        onChange={(e) => front.set('name', e.currentTarget.value)}
      />
      <Textarea
        variant="unstyled"
        size="xs"
        autosize
        minRows={1}
        aria-label="Description"
        placeholder="What the skill is for and when to load it"
        styles={{ input: { color: 'var(--mantine-color-dimmed)' } }}
        value={description}
        onChange={(e) => front.set('description', e.currentTarget.value)}
      />
    </div>
  )
}

/** The editor on an open session (exported for tests, which hand it a doc without a host). */
export function SkillDocument({ name, session }: { name: string; session: Session }) {
  const { doc, provider, user } = session
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  // A comment being written (the text it is about), and the thread shown open.
  const [draft, setDraft] = useState<TextAnchor | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  // What the comments plugin and the bubble read (they are set up once per editor).
  const marks = useRef<{ draft: TextAnchor | null; open: string | null }>({
    draft: null,
    open: null,
  })
  const editor = useEditor(
    {
      extensions: [
        ...skillSchemaExtensions(),
        Collaboration.configure({ document: doc, field: 'body' }),
        CollaborationCaret.configure({ provider, user, render: caretRender, selectionRender }),
        Placeholder.configure({ placeholder: 'Write the skill' }),
        DocComments.configure({
          doc,
          active: () => marks.current.open,
          pending: () => marks.current.draft,
          onClick: (thread) => {
            setDraft(null)
            setOpenId(thread)
          },
        }),
      ],
      editorProps: { attributes: { 'aria-label': 'SKILL.md', spellcheck: 'false' } },
    },
    [doc, provider],
  )
  useEffect(() => {
    marks.current = { draft, open: openId }
    if (editor) redrawComments(editor)
  }, [editor, draft, openId])

  const comment = (): void => {
    if (!editor) return
    const { from, to } = editor.state.selection
    const anchor = anchorOf(editor.state, from, to)
    if (anchor === null) return
    setOpenId(null)
    setDraft(anchor)
  }
  const save = async (force: boolean): Promise<void> => {
    setBusy(true)
    try {
      const r = await invoke('skills.save', force ? { name, force } : { name })
      if (!r.ok) failed('save', r.error.message)
      setConflict(r.ok && r.value.status === 'changed-on-disk')
    } finally {
      setBusy(false)
    }
  }
  const reload = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await invoke('skills.reload', { name })
      if (r.ok) setConflict(false)
      else failed('reload', r.error.message)
    } finally {
      setBusy(false)
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 's') return
    e.preventDefault()
    e.stopPropagation()
    if (!busy) void save(false)
  }

  return (
    <div className="eva-skills-doc" onKeyDown={onKeyDown} data-testid="skill-editor">
      <SkillDocBar
        state={doc.getMap('state')}
        conflict={conflict}
        busy={busy}
        onSave={(force) => void save(force)}
        onReload={() => void reload()}
      />
      <RichTextEditor editor={editor} variant="subtle" className="eva-skills-sheet">
        <FrontHeader front={doc.getMap('front')} />
        {editor ? (
          <BubbleMenu
            editor={editor}
            className="eva-skills-bubble-wrap"
            options={{ placement: 'top-start', offset: 8, shift: { padding: 8 } }}
            shouldShow={({ view, state, from, to, element }) =>
              marks.current.draft === null &&
              editor.isEditable &&
              !state.selection.empty &&
              state.doc.textBetween(from, to).length > 0 &&
              (view.hasFocus() || element.contains(document.activeElement))
            }
          >
            <SkillToolbar editor={editor} onComment={comment} />
          </BubbleMenu>
        ) : null}
        <RichTextEditor.Content className="eva-skills-prose" />
        {editor ? (
          <DocThreads
            editor={editor}
            doc={doc}
            user={user}
            draft={draft}
            openId={openId}
            onDraftDone={(thread) => {
              // The selection collapses to its end, so the formatting toolbar does not sit over the thread.
              editor.commands.setTextSelection(editor.state.selection.to)
              setDraft(null)
              setOpenId(thread)
            }}
            onClose={() => {
              setDraft(null)
              setOpenId(null)
              editor.commands.focus()
            }}
          />
        ) : null}
      </RichTextEditor>
    </div>
  )
}

/**
 * The Editor tab: the skill's live document on the Relay host, rendered and edited in place.
 * Everyone editing the skill (Isaac here, agents through the host) shares one Y.Doc, so their
 * named carets show where they are.
 */
export function SkillEditor({ name }: { name: string }) {
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    let opened: Session | null = null
    void invoke('skills.open', { name }).then(
      (r) => {
        if (!alive) return
        if (!r.ok) {
          setError(r.error.message)
          return
        }
        const doc = new Y.Doc()
        const provider = new WebsocketProvider(r.value.serverUrl, r.value.room, doc, {
          params: { token: r.value.token },
        })
        opened = { doc, provider, user: r.value.user }
        const session = opened
        // The editor mounts on the host's content, never on the empty doc before the first sync
        // (an editor on an empty fragment would show a blank skill and could seed it with a paragraph).
        const ready = (synced: boolean): void => {
          if (!synced || !alive) return
          provider.off('sync', ready)
          setSession(session)
        }
        provider.on('sync', ready)
      },
      (e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      },
    )
    return () => {
      alive = false
      opened?.provider.destroy()
      opened?.doc.destroy()
    }
  }, [name])

  if (error !== null) {
    return <div className="eva-skills-quiet">Could not open SKILL.md: {error}</div>
  }
  if (session === null) return <div className="eva-skills-quiet">Opening SKILL.md</div>
  return <SkillDocument name={name} session={session} />
}
