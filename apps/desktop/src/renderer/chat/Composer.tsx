import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { slashMatches, type SlashCommand } from '@evaos/chat-core/launch'
import { ActionIcon, Textarea } from '@mantine/core'
import { IconArrowUp, IconPlayerStopFilled, IconPlus } from '@tabler/icons-react'
import { invoke } from '../ipc'
import { chatStore, useChatStore } from './chat-store'
import { WriterPrompt } from './WriterPrompt'
import { ImageChips } from './composer/ImageChips'
import { Toolbar } from './composer/Toolbar'
import { useLaunchState } from './composer/useLaunchState'
import { SlashMenu } from './composer/SlashMenu'
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_PROMPT_IMAGES,
  readImageFiles,
  type ReadImage,
} from './composer/image-input'
import './composer/composer.css'
import { DISMISS_PRIORITY, useDismissable } from '../hotkeys/dismiss'

type Attached = ReadImage & { id: string }

const NOTICE = {
  'not-image': 'Only images can be attached.',
  'too-large': 'Images must be 20 MB or smaller.',
  'too-many': `You can attach up to ${MAX_PROMPT_IMAGES} images.`,
  'no-images': 'This model does not accept images.',
} as const

const hasFiles = (e: React.DragEvent): boolean =>
  Array.from(e.dataTransfer?.types ?? []).includes('Files')

/** What the chat pane can ask of its composer: send a widget's reply as the next turn. */
export interface ComposerHandle {
  sendReply(text: string): void
}

/**
 * Composer: Enter sends (a send while a reply runs is a steer), Shift+Enter inserts a newline.
 * Stop and Escape abort the running turn. Images arrive by paste, drop or the attach button.
 * Widget replies go through the same send (`ref.sendReply`) without touching the draft.
 */
export function Composer({
  paneId,
  disabled,
  ref,
}: {
  paneId: string
  disabled: boolean
  ref?: Ref<ComposerHandle>
}) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<Attached[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [focused, setFocused] = useState(false)
  /** Set while the shared writer prompt is open: main's message for why it asked. */
  const [writerPrompt, setWriterPrompt] = useState<string | null>(null)
  const dragDepth = useRef(0)
  const nextId = useRef(0)
  const picker = useRef<HTMLInputElement>(null)
  /** A widget reply main asked to confirm (owned elsewhere): resent as-is on confirm. */
  const pendingReply = useRef<string | null>(null)
  const imagesRef = useRef(images)
  imagesRef.current = images
  const running = useChatStore((s) => s.panes[paneId]?.running ?? false)
  const stopped = useChatStore((s) => s.panes[paneId]?.stopped ?? false)
  const launch = useLaunchState(paneId, !disabled)
  const imagesBlocked = launch.state !== null && !launch.state.imagesAllowed
  const hasError = useChatStore((s) => (s.panes[paneId]?.error ?? null) !== null)
  /** omp's `/` commands, fetched the first time a draft starts with `/`. Claude chats get none. */
  const [commands, setCommands] = useState<SlashCommand[] | null>(null)
  const [slashIx, setSlashIx] = useState(0)
  /** Esc closes the menu until the text changes again. */
  const [slashHidden, setSlashHidden] = useState(false)
  const ompChat = launch.state?.harness !== 'claude'
  const wantsCommands = ompChat && commands === null && text.startsWith('/')
  useEffect(() => {
    if (!wantsCommands) return
    let stale = false
    void invoke('chat.commands', {}).then((r) => {
      if (!stale && r.ok) setCommands(r.value.commands)
    })
    return () => {
      stale = true
    }
  }, [wantsCommands])
  const slash =
    ompChat && !slashHidden && commands && !disabled
      ? slashMatches(commands, text)
      : { prefix: '', hits: [] }
  const slashSelected = Math.min(slashIx, Math.max(slash.hits.length - 1, 0))

  /**
   * Fills the draft with the highlighted command and a space for what follows. False when the
   * menu is closed or (`enter`) the choice is already typed out in full, so Enter sends it.
   */
  const completeSlash = (enter: boolean, index = slashSelected): boolean => {
    const name = slash.hits[index]?.name
    if (name === undefined) return false
    if (enter && text.trim() === `${slash.prefix}${name}`) return false
    setText(`${slash.prefix}${name} `)
    setSlashIx(0)
    return true
  }

  // Object URLs still held on unmount are released (T-04-30).
  useEffect(
    () => () => {
      for (const img of imagesRef.current) URL.revokeObjectURL(img.previewUrl)
    },
    [],
  )

  const abort = async (): Promise<void> => {
    await invoke('chat.abort', { paneId })
  }

  // The window router handles Escape in capture phase. Claim it ahead of sidebar Back
  // only while this composer has focus; modal/popover dismissers keep their priority.
  useDismissable(DISMISS_PRIORITY.subPageBack + 1, () => void abort(), running && focused)
  // An open `/` menu takes Escape ahead of the abort above.
  useDismissable(
    DISMISS_PRIORITY.subPageBack + 2,
    () => setSlashHidden(true),
    focused && slash.hits.length > 0,
  )

  const attach = async (files: File[]): Promise<void> => {
    if (disabled || files.length === 0) return
    if (imagesBlocked) {
      setNotice(NOTICE['no-images'])
      return
    }
    const read = await readImageFiles(
      files,
      Math.max(MAX_PROMPT_IMAGES - imagesRef.current.length, 0),
    )
    // Capacity is read again after the await: an overlapping paste or drop may have filled it.
    const room = Math.max(MAX_PROMPT_IMAGES - imagesRef.current.length, 0)
    const kept = read.images.slice(0, room)
    for (const extra of read.images.slice(kept.length)) URL.revokeObjectURL(extra.previewUrl)
    setNotice(
      read.rejected
        ? NOTICE[read.rejected]
        : read.truncated || read.images.length > kept.length
          ? NOTICE['too-many']
          : null,
    )
    if (kept.length > 0) {
      setImages((cur) => [...cur, ...kept.map((k) => ({ ...k, id: `img-${nextId.current++}` }))])
    }
  }

  const remove = (id: string): void => {
    setImages((cur) => {
      const gone = cur.find((i) => i.id === id)
      if (gone) URL.revokeObjectURL(gone.previewUrl)
      return cur.filter((i) => i.id !== id)
    })
  }

  const canSend = !disabled && (text.trim() !== '' || images.length > 0)

  /** Sends the draft, or with `reply` a widget's text, leaving the draft as it is. */
  const send = async (force = false, reply?: string): Promise<void> => {
    const draft = reply === undefined
    const value = (draft ? text : reply).trim()
    const sending = draft ? images : []
    if ((value === '' && sending.length === 0) || disabled) return
    if (draft) {
      setText('')
      setImages([])
    }
    setNotice(null)
    const payload = {
      paneId,
      text: value,
      ...(force ? { force: true } : {}),
      ...(sending.length > 0
        ? { images: sending.map((i) => ({ mimeType: i.mimeType, data: i.data })) }
        : {}),
    }
    const r = await invoke('chat.send', payload as Parameters<typeof invoke<'chat.send'>>[1])
    if (r.ok) {
      // A prompt that went through supersedes any earlier failure or unexpected exit.
      chatStore.getState().setError(paneId, null)
      for (const img of sending) URL.revokeObjectURL(img.previewUrl)
    } else {
      if (draft) {
        // Give the prompt back unless something new was typed meanwhile.
        setText((current) => (current === '' ? value : current))
        setImages((current) => [...sending, ...current])
      }
      if (r.error.code === 'owned-elsewhere') {
        pendingReply.current = draft ? null : value
        setWriterPrompt(r.error.message)
      } else chatStore.getState().setError(paneId, r.error.message)
    }
  }

  useImperativeHandle(ref, () => ({ sendReply: (reply) => void send(false, reply) }))

  const edit = (value: string): void => {
    setText(value)
    setSlashIx(0)
    setSlashHidden(false)
    // Dismissed, not cleared: main keeps its error until the next prompt, and a resync in
    // between must not bring the banner back.
    if (hasError) chatStore.getState().dismissError(paneId)
  }

  return (
    <div
      className="eva-composer"
      data-testid="composer"
      data-dragging={dragging ? 'true' : undefined}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
          f.type.startsWith('image/'),
        )
        if (files.length === 0) return
        e.preventDefault()
        void attach(files)
      }}
      onDragEnter={(e) => {
        if (!hasFiles(e) || disabled) return
        e.preventDefault()
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragOver={(e) => {
        if (hasFiles(e) && !disabled) e.preventDefault()
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        void attach(Array.from(e.dataTransfer.files))
      }}
    >
      <div className="eva-composer-frame">
        {dragging ? <div className="eva-composer-drop">Drop images to attach</div> : null}
        {slash.hits.length > 0 ? (
          <SlashMenu
            prefix={slash.prefix}
            hits={slash.hits}
            selected={slashSelected}
            onPick={(i) => completeSlash(false, i)}
          />
        ) : null}
        <ImageChips chips={images} onRemove={remove} />
        <Textarea
          autosize
          minRows={2}
          maxRows={8}
          className="eva-composer-field"
          classNames={{ input: 'eva-composer-input' }}
          variant="unstyled"
          data-testid="composer-input"
          aria-label="Message"
          placeholder={
            disabled || stopped
              ? 'Session is not running. Resume it to send a message.'
              : 'Ask anything, or start with / for a command'
          }
          disabled={disabled}
          value={text}
          onChange={(e) => edit(e.currentTarget.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (slash.hits.length > 0) {
              const n = slash.hits.length
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setSlashIx((slashSelected + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
                return
              }
              if (e.key === 'Tab' && !e.shiftKey) {
                e.preventDefault()
                completeSlash(false)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setSlashHidden(true)
                return
              }
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                completeSlash(true)
              ) {
                e.preventDefault()
                return
              }
            }
            if (e.key === 'Escape' && running) {
              e.preventDefault()
              void abort()
              return
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <Toolbar
          paneId={paneId}
          disabled={disabled}
          launch={launch}
          attach={
            <>
              <input
                ref={picker}
                type="file"
                hidden
                multiple
                accept={ACCEPTED_IMAGE_TYPES.join(',')}
                data-testid="composer-file-input"
                onChange={(e) => {
                  const files = Array.from(e.currentTarget.files ?? [])
                  e.currentTarget.value = ''
                  void attach(files)
                }}
              />
              <ActionIcon
                className="eva-composer-attach"
                size="var(--eva-kit-control-sm)"
                variant="subtle"
                aria-label="Attach image"
                aria-disabled={disabled || imagesBlocked}
                disabled={disabled || imagesBlocked}
                onClick={() => picker.current?.click()}
              >
                <IconPlus size="calc(var(--eva-font-size) * .875)" />
              </ActionIcon>
            </>
          }
        >
          {running ? (
            <ActionIcon
              className="eva-composer-round"
              size="var(--eva-tile-md)"
              variant="default"
              data-testid="composer-stop"
              aria-label="Stop response"
              onClick={() => void abort()}
            >
              <IconPlayerStopFilled size="calc(var(--eva-font-size) * .75)" />
            </ActionIcon>
          ) : null}
          <ActionIcon
            className="eva-composer-round"
            size="var(--eva-tile-md)"
            variant="filled"
            data-testid="composer-send"
            aria-label="Send message"
            disabled={!canSend}
            onClick={() => void send()}
          >
            <IconArrowUp size="calc(var(--eva-font-size) * .875)" />
          </ActionIcon>
        </Toolbar>
      </div>
      <WriterPrompt
        opened={writerPrompt !== null}
        message={writerPrompt ?? ''}
        onCancel={() => {
          pendingReply.current = null
          setWriterPrompt(null)
        }}
        onConfirm={() => {
          setWriterPrompt(null)
          void send(true, pendingReply.current ?? undefined)
        }}
      />
      {notice ? (
        <div className="eva-composer-notice" role="status">
          {notice}
        </div>
      ) : null}
    </div>
  )
}
