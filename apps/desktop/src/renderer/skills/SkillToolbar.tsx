import { useState, type ReactNode } from 'react'
import { ActionIcon, Button, TextInput, Tooltip } from '@mantine/core'
import { useEditorState, type ChainedCommands, type Editor } from '@tiptap/react'
import {
  IconBold,
  IconChevronDown,
  IconCode,
  IconItalic,
  IconLink,
  IconList,
  IconListNumbers,
  IconMessageCirclePlus,
  IconStrikethrough,
} from '@tabler/icons-react'
import { EvaMenu } from '../overlay'

const HEADINGS = [
  { label: 'Heading 1', level: 1 },
  { label: 'Heading 2', level: 2 },
  { label: 'Heading 3', level: 3 },
] as const

/** One formatting button: icon only, its name and shortcut in a tooltip, tinted while active. */
function Tool({
  label,
  shortcut,
  active,
  onClick,
  children,
}: {
  label: string
  shortcut?: string
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip label={shortcut ? `${label}  ${shortcut}` : label} openDelay={400} withinPortal>
      <ActionIcon
        variant={active ? 'light' : 'subtle'}
        color={active ? undefined : 'gray'}
        size={28}
        aria-label={label}
        aria-pressed={active}
        data-testid={`skill-tool-${label.toLowerCase().replace(/\s+/g, '-')}`}
        onClick={onClick}
      >
        {children}
      </ActionIcon>
    </Tooltip>
  )
}

/** The block type: Paragraph or Heading 1 to 3, showing the current one. */
function BlockMenu({ editor, level }: { editor: Editor; level: number | null }) {
  const [opened, setOpened] = useState(false)
  const current = HEADINGS.find((h) => h.level === level)?.label ?? 'Paragraph'
  return (
    <EvaMenu opened={opened} onChange={setOpened} position="bottom-start" offset={6} width={160}>
      <EvaMenu.Target>
        <Button
          variant="subtle"
          color="gray"
          size="compact-sm"
          h={28}
          aria-label="Text style"
          rightSection={<IconChevronDown size={14} />}
          className="eva-skills-tool-text"
        >
          {current}
        </Button>
      </EvaMenu.Target>
      <EvaMenu.Dropdown>
        <EvaMenu.Item onClick={() => editor.chain().focus().setParagraph().run()}>
          Paragraph
        </EvaMenu.Item>
        {HEADINGS.map((h) => (
          <EvaMenu.Item
            key={h.level}
            onClick={() => editor.chain().focus().setHeading({ level: h.level }).run()}
          >
            {h.label}
          </EvaMenu.Item>
        ))}
      </EvaMenu.Dropdown>
    </EvaMenu>
  )
}

/**
 * The link address, typed in the toolbar itself in place of the buttons (empty removes the link).
 * It stays inside the bubble, so focus never leaves it and the bubble stays open.
 */
function LinkField({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const [url, setUrl] = useState(
    () => (editor.getAttributes('link')['href'] as string | undefined) ?? '',
  )
  const apply = (): void => {
    const href = url.trim()
    const chain = editor.chain().focus().extendMarkRange('link')
    if (href === '') chain.unsetLink().run()
    else chain.setLink({ href }).run()
    onDone()
  }
  return (
    <TextInput
      size="xs"
      w={260}
      variant="unstyled"
      px={8}
      autoFocus
      aria-label="Link address"
      placeholder="Paste a link, Enter to apply"
      value={url}
      onChange={(e) => setUrl(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          apply()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          editor.commands.focus()
          onDone()
        }
      }}
    />
  )
}

/**
 * The selection toolbar (BlockNote's formatting toolbar in Relay's theme): block type, inline
 * marks and link, lists, then Comment, which anchors a thread to the selected text. A quote stays
 * a typed "> ".
 */
export function SkillToolbar({ editor, onComment }: { editor: Editor; onComment: () => void }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      level: HEADINGS.find((h) => e.isActive('heading', { level: h.level }))?.level ?? null,
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
    }),
  })
  const [linking, setLinking] = useState(false)
  const run = (fn: (c: ChainedCommands) => ChainedCommands) => () =>
    fn(editor.chain().focus()).run()
  if (linking)
    return (
      <div
        className="eva-skills-toolbar"
        role="toolbar"
        aria-label="Link"
        data-testid="skill-bubble"
      >
        <LinkField editor={editor} onDone={() => setLinking(false)} />
      </div>
    )
  return (
    <div
      className="eva-skills-toolbar"
      role="toolbar"
      aria-label="Format"
      data-testid="skill-bubble"
    >
      <BlockMenu editor={editor} level={s.level} />
      <span className="eva-skills-toolbar-sep" />
      <Tool label="Bold" shortcut="⌘B" active={s.bold} onClick={run((c) => c.toggleBold())}>
        <IconBold size={16} stroke={1.75} />
      </Tool>
      <Tool label="Italic" shortcut="⌘I" active={s.italic} onClick={run((c) => c.toggleItalic())}>
        <IconItalic size={16} stroke={1.75} />
      </Tool>
      <Tool
        label="Strikethrough"
        shortcut="⌘⇧S"
        active={s.strike}
        onClick={run((c) => c.toggleStrike())}
      >
        <IconStrikethrough size={16} stroke={1.75} />
      </Tool>
      <Tool label="Code" shortcut="⌘E" active={s.code} onClick={run((c) => c.toggleCode())}>
        <IconCode size={16} stroke={1.75} />
      </Tool>
      <Tool label="Link" shortcut="⌘K" active={s.link} onClick={() => setLinking(true)}>
        <IconLink size={16} stroke={1.75} />
      </Tool>
      <span className="eva-skills-toolbar-sep" />
      <Tool label="Bulleted list" active={s.bullet} onClick={run((c) => c.toggleBulletList())}>
        <IconList size={16} stroke={1.75} />
      </Tool>
      <Tool label="Numbered list" active={s.ordered} onClick={run((c) => c.toggleOrderedList())}>
        <IconListNumbers size={16} stroke={1.75} />
      </Tool>
      <span className="eva-skills-toolbar-sep" />
      <Tooltip label="Comment, ask or request a change" openDelay={400} withinPortal>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={28}
          aria-label="Comment"
          data-testid="skill-tool-comment"
          onClick={onComment}
        >
          <IconMessageCirclePlus size={16} stroke={1.75} />
        </ActionIcon>
      </Tooltip>
    </div>
  )
}
