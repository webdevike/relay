import { createPortal } from 'react-dom'
import { useEffect, useState, type Ref } from 'react'
import {
  IconArrowBackUp,
  IconCopy,
  IconMarkdown,
  IconPin,
  IconSelectAll,
} from '@tabler/icons-react'
import { EvaMenu } from '../../overlay'

export interface BubbleMenuActions {
  reply(): void
  copy(): void
  /** Assistant replies only: the reply's markdown source. */
  copyMarkdown?: () => void
  selectText(): void
  /** Pins: the whole message (it unpins when it already is pinned), and the text selected in it when there is some. */
  pinMessage?: { pinned: boolean; run: () => void }
  pinSelection?: () => void
}

/**
 * The bubble's context menu at the pointer (right-click, or the context-menu key on its react
 * button): Reply, Copy, Copy as Markdown for a reply, Select text. Portalled to the body like the
 * chat list's row menu, so a transformed ancestor never shifts it off the pointer.
 */
export function BubbleMenu({
  at,
  onClose,
  actions,
  dropdownRef,
}: {
  /** Where it opens (viewport px); null when closed. */
  at: { x: number; y: number } | null
  onClose(): void
  actions: BubbleMenuActions
  dropdownRef?: Ref<HTMLDivElement>
}) {
  // Reply puts focus in the composer; the menu's own return of focus to whatever held it when it
  // opened (the pane body) would take it straight back. Every other item returns it.
  const [replied, setReplied] = useState(false)
  const opened = at !== null
  useEffect(() => {
    if (opened) setReplied(false)
  }, [opened])
  return createPortal(
    <EvaMenu
      opened={opened}
      onChange={(o) => {
        if (!o) onClose()
      }}
      width={200}
      position="bottom-start"
      offset={0}
      closeOnClickOutside={false}
      returnFocus={!replied}
    >
      <EvaMenu.Target>
        <span
          className="eva-bubble-menu-anchor"
          style={{ left: at?.x ?? 0, top: at?.y ?? 0 }}
          aria-hidden
        />
      </EvaMenu.Target>
      <EvaMenu.Dropdown ref={dropdownRef} data-testid="bubble-menu">
        <EvaMenu.Item
          data-testid="bubble-menu-reply"
          leftSection={<IconArrowBackUp size={16} stroke={1.5} />}
          onClick={() => {
            setReplied(true)
            actions.reply()
          }}
        >
          Reply
        </EvaMenu.Item>
        <EvaMenu.Item
          data-testid="bubble-menu-copy"
          leftSection={<IconCopy size={16} stroke={1.5} />}
          onClick={actions.copy}
        >
          Copy
        </EvaMenu.Item>
        {actions.copyMarkdown ? (
          <EvaMenu.Item
            data-testid="bubble-menu-markdown"
            leftSection={<IconMarkdown size={16} stroke={1.5} />}
            onClick={actions.copyMarkdown}
          >
            Copy as Markdown
          </EvaMenu.Item>
        ) : null}
        <EvaMenu.Item
          data-testid="bubble-menu-select"
          leftSection={<IconSelectAll size={16} stroke={1.5} />}
          onClick={actions.selectText}
        >
          Select text
        </EvaMenu.Item>
        {actions.pinMessage ? (
          <EvaMenu.Item
            data-testid="bubble-menu-pin"
            leftSection={<IconPin size={16} stroke={1.5} />}
            onClick={actions.pinMessage.run}
          >
            {actions.pinMessage.pinned ? 'Unpin message' : 'Pin message'}
          </EvaMenu.Item>
        ) : null}
        {actions.pinSelection ? (
          <EvaMenu.Item
            data-testid="bubble-menu-pin-selection"
            leftSection={<IconPin size={16} stroke={1.5} />}
            onClick={actions.pinSelection}
          >
            Pin selection
          </EvaMenu.Item>
        ) : null}
      </EvaMenu.Dropdown>
    </EvaMenu>,
    document.body,
  )
}
