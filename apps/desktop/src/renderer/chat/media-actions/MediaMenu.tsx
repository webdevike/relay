import { createPortal } from 'react-dom'
import { useState, type MouseEvent, type ReactNode } from 'react'
import { IconCopy, IconDownload, IconLink } from '@tabler/icons-react'
import { EvaMenu } from '../../overlay'
import { copyAddress, copyImage, hasAddress, saveMedia, type MediaTarget } from './media-actions'
import './media-actions.css'

/**
 * A picture's or video's own context menu at the pointer: Copy Image, Save Image As… and Copy
 * Image Address (a video: Save Video As… and Copy Video Address). Portalled to the body like the
 * bubble's menu, and opened instead of it: the right-click stops at the media.
 */
function MediaMenu({
  at,
  target,
  onClose,
}: {
  at: { x: number; y: number }
  target: MediaTarget
  onClose(): void
}) {
  const video = target.kind === 'video'
  return createPortal(
    <EvaMenu
      opened
      onChange={(o) => {
        if (!o) onClose()
      }}
      width={220}
      position="bottom-start"
      offset={0}
    >
      <EvaMenu.Target>
        <span className="eva-media-menu-anchor" style={{ left: at.x, top: at.y }} aria-hidden />
      </EvaMenu.Target>
      {/* React events bubble out of a portal to the media's ancestors (a link, an image button,
          the bubble): none of them hears a click or right-click in the menu. */}
      <EvaMenu.Dropdown
        data-testid="media-menu"
        data-kind={target.kind}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        {video ? null : (
          <EvaMenu.Item
            data-testid="media-menu-copy"
            leftSection={<IconCopy size={16} stroke={1.5} />}
            onClick={() => void copyImage(target)}
          >
            Copy Image
          </EvaMenu.Item>
        )}
        <EvaMenu.Item
          data-testid="media-menu-save"
          leftSection={<IconDownload size={16} stroke={1.5} />}
          onClick={() => void saveMedia(target)}
        >
          {video ? 'Save Video As…' : 'Save Image As…'}
        </EvaMenu.Item>
        {hasAddress(target) ? (
          <EvaMenu.Item
            data-testid="media-menu-address"
            leftSection={<IconLink size={16} stroke={1.5} />}
            onClick={() => void copyAddress(target)}
          >
            {video ? 'Copy Video Address' : 'Copy Image Address'}
          </EvaMenu.Item>
        ) : null}
      </EvaMenu.Dropdown>
    </EvaMenu>,
    document.body,
  )
}

/**
 * The media menu for one picture or video: spread `onContextMenu(target)` on the element that
 * shows it and render `menu` beside it. A right-click (or the context-menu key, Shift+F10, on a
 * focused image button) opens it at the pointer, under the element from the keyboard. Chat videos
 * never enter Chromium's full screen (their full screen is the app's viewer); should anything
 * else be full screen, no menu opens, since it would draw under it.
 */
export function useMediaMenu(): {
  onContextMenu(target: MediaTarget | null): (e: MouseEvent<HTMLElement>) => void
  menu: ReactNode
} {
  const [open, setOpen] = useState<{ at: { x: number; y: number }; target: MediaTarget } | null>(
    null,
  )
  return {
    onContextMenu: (target) => (e) => {
      // Not loaded yet (no source main can act on): the bubble's own menu still opens.
      if (target === null || document.fullscreenElement) return
      e.preventDefault()
      e.stopPropagation()
      const r = e.currentTarget.getBoundingClientRect()
      const keyboard = e.clientX === 0 && e.clientY === 0
      const at = keyboard ? { x: r.left, y: r.bottom } : { x: e.clientX, y: e.clientY }
      setOpen({ at, target })
    },
    menu:
      open === null ? null : (
        <MediaMenu at={open.at} target={open.target} onClose={() => setOpen(null)} />
      ),
  }
}
