import { useEffect, useState, type KeyboardEvent } from 'react'
import { Group, Paper, Textarea, TextInput } from '@mantine/core'
import { RichTextEditor } from '@mantine/tiptap'
import { notifications } from '@mantine/notifications'
import '@mantine/tiptap/styles.css'
import { useEditor, useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { Placeholder } from '@tiptap/extensions'
import { IconChevronDown } from '@tabler/icons-react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type { SkillUser } from '@evaos/contract'
import { invoke } from '../ipc'
import { EvaMenu } from '../overlay'
import { skillSchemaExtensions } from './skill-schema'
import { SkillDocBar } from './SkillDocBar'
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

const HEADINGS = [
  { label: 'Heading 1', short: 'H1', level: 1 },
  { label: 'Heading 2', short: 'H2', level: 2 },
  { label: 'Heading 3', short: 'H3', level: 3 },
] as const

/** The bubble's block menu: H1 to H3 or Paragraph, showing the current one. */
function BlockMenu({ editor }: { editor: Editor }) {
  const [opened, setOpened] = useState(false)
  const level = useEditorState({
    editor,
    selector: ({ editor: e }) => HEADINGS.find((h) => e.isActive('heading', { level: h.level })),
  })
  return (
    <EvaMenu opened={opened} onChange={setOpened} position="bottom-start" offset={6} width={160}>
      <EvaMenu.Target>
        <RichTextEditor.Control aria-label="Text style" w="auto" px={6}>
          <Group gap={4} wrap="nowrap">
            {level?.short ?? 'Text'}
            <IconChevronDown size={12} />
          </Group>
        </RichTextEditor.Control>
      </EvaMenu.Target>
      <EvaMenu.Dropdown>
        {HEADINGS.map((h) => (
          <EvaMenu.Item
            key={h.level}
            onClick={() => editor.chain().focus().setHeading({ level: h.level }).run()}
          >
            {h.label}
          </EvaMenu.Item>
        ))}
        <EvaMenu.Item onClick={() => editor.chain().focus().setParagraph().run()}>
          Paragraph
        </EvaMenu.Item>
      </EvaMenu.Dropdown>
    </EvaMenu>
  )
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
  const editor = useEditor(
    {
      extensions: [
        ...skillSchemaExtensions(),
        Collaboration.configure({ document: doc, field: 'body' }),
        CollaborationCaret.configure({ provider, user, selectionRender }),
        Placeholder.configure({ placeholder: 'Write the skill' }),
      ],
      editorProps: { attributes: { 'aria-label': 'SKILL.md', spellcheck: 'false' } },
    },
    [doc, provider],
  )

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
            options={{ placement: 'top-start', offset: 8 }}
          >
            <Paper shadow="md" withBorder p={4} data-testid="skill-bubble">
              <Group gap={4} wrap="nowrap">
                <RichTextEditor.ControlsGroup>
                  <BlockMenu editor={editor} />
                </RichTextEditor.ControlsGroup>
                <RichTextEditor.ControlsGroup>
                  <RichTextEditor.Bold />
                  <RichTextEditor.Italic />
                  <RichTextEditor.Strikethrough />
                  <RichTextEditor.Code />
                  <RichTextEditor.Link popoverProps={{ withinPortal: false }} />
                </RichTextEditor.ControlsGroup>
                <RichTextEditor.ControlsGroup>
                  <RichTextEditor.BulletList />
                  <RichTextEditor.OrderedList />
                  <RichTextEditor.Blockquote />
                </RichTextEditor.ControlsGroup>
              </Group>
            </Paper>
          </BubbleMenu>
        ) : null}
        <RichTextEditor.Content className="eva-skills-prose" />
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
