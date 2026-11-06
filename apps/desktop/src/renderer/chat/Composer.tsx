import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { slashMatches, type SlashCommand } from '@evaos/chat-core/launch'
import { ActionIcon, Textarea, Tooltip } from '@mantine/core'
import {
  IconArrowUp,
  IconChevronLeft,
  IconDeviceDesktop,
  IconPlayerStopFilled,
  IconPlus,
} from '@tabler/icons-react'
import { invoke } from '../ipc'
import { chatStore, useChatStore } from './chat-store'
import { draftText, saveDraft, useDraftsLoaded } from './drafts'
import { composerFillStore, takeComposerFill } from './composer-fill'
import { WriterPrompt } from './WriterPrompt'
import { ImageChips } from './composer/ImageChips'
import { Toolbar } from './composer/Toolbar'
import { useLaunchState } from './composer/useLaunchState'
import { SlashMenu, type MenuRow } from './composer/SlashMenu'
import { ComputerChip } from './composer/ComputerChip'
import {
  atQueryAt,
  atRows,
  splitChip,
  withChip,
  type AtLevel,
  type AtRow,
  type ComputerMode,
} from './composer/at-menu'
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_PROMPT_IMAGES,
  readImageFiles,
  type ReadImage,
} from './composer/image-input'
import './composer/composer.css'
import { DISMISS_PRIORITY, useDismissable } from '../hotkeys/dismiss'
import { notifications } from '@mantine/notifications'

const ABORT_WINDOW_MS = 500
const STOP_TOAST_ID = 'composer-stop-hint'
const STOP_TOOLTIP = 'Stop (press Esc twice, or ⌘.)'

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

/** The text box's content and the draft key it belongs to (undefined until drafts load). */
interface Box {
  key: string | null | undefined
  text: string
  /** The Computer chip's mode, when the draft has the chip. */
  computer: ComputerMode | null
  /** A new chat's draft key the text moved from when omp named its session file. */
  movedFrom?: string
}

/** The box a chat's saved draft opens as (a saved `@computer <mode> ` head becomes the chip). */
const boxFor = (key: string | null | undefined): Box => {
  const { mode, text } = splitChip(key ? draftText(key) : '')
  return { key, text, computer: mode }
}

/**
 * Composer: Enter sends (a send while a reply runs is a steer), Shift+Enter inserts a newline.
 * The Stop button, double Escape (inside 500 ms) and Cmd+. abort the running turn; a single
 * Escape only closes what is open, else blurs. Images arrive by paste, drop or the attach button.
 * Widget replies go through the same send (`ref.sendReply`) without touching the draft.
 * The unsent text is saved per `draftKey` (drafts.ts) and comes back when that chat shows again,
 * after a restart too, without moving focus. Attached images are not saved.
 */
export function Composer({
  paneId,
  disabled,
  draftKey = null,
  ref,
}: {
  paneId: string
  disabled: boolean
  /** Where the unsent text is saved (draftKeyFor); null keeps it unsaved. */
  draftKey?: string | null
  ref?: Ref<ComposerHandle>
}) {
  const loaded = useDraftsLoaded()
  const key = loaded ? draftKey : undefined
  const boundTo = useChatStore((s) => s.panes[paneId]?.boundTo ?? null)
  const [box, setBox] = useState<Box>(() => boxFor(key))
  if (box.key !== key) {
    // Another chat shows: its saved draft replaces the text. Text typed before drafts loaded
    // stays, and so does a new chat's text when omp gives it a session file.
    const keep =
      (box.key === undefined && (box.text !== '' || box.computer !== null)) ||
      (typeof box.key === 'string' && box.key.startsWith('draft:') && key === boundTo)
    setBox(
      keep
        ? {
            key,
            text: box.text,
            computer: box.computer,
            ...(box.key ? { movedFrom: box.key } : {}),
          }
        : boxFor(key),
    )
  }
  useEffect(() => {
    if (box.movedFrom) saveDraft(box.movedFrom, '')
    if (box.key) saveDraft(box.key, withChip(box.computer, box.text))
  }, [box])
  const boxRef = useRef(box)
  boxRef.current = box
  const text = box.text
  const computer = box.computer
  const setText = (next: string | ((cur: string) => string)): void =>
    setBox((b) => ({
      key: b.key,
      computer: b.computer,
      text: typeof next === 'function' ? next(b.text) : next,
    }))
  const setComputer = (mode: ComputerMode | null): void =>
    setBox((b) => ({ key: b.key, text: b.text, computer: mode }))
  const [images, setImages] = useState<Attached[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [focused, setFocused] = useState(false)
  /** Set while the shared writer prompt is open: main's message for why it asked. */
  const [writerPrompt, setWriterPrompt] = useState<string | null>(null)
  const dragDepth = useRef(0)
  const nextId = useRef(0)
  const picker = useRef<HTMLInputElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const root = useRef<HTMLDivElement>(null)
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
  const [caret, setCaret] = useState(0)
  const atQuery = !disabled && !text.startsWith('/') ? atQueryAt(text, caret) : null
  const wantsCommands = ompChat && commands === null && (text.startsWith('/') || atQuery !== null)
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

  // The `@` menu: Computer (opens its modes), then skills. Esc closes it until the text changes.
  const [atLevel, setAtLevel] = useState<AtLevel>('top')
  const [atIx, setAtIx] = useState(0)
  const [atHidden, setAtHidden] = useState(false)
  const atOpen = atQuery !== null
  useEffect(() => {
    if (!atOpen) setAtLevel('top')
  }, [atOpen])
  const at: AtRow[] = atQuery && !atHidden ? atRows(commands, atQuery.query, atLevel) : []
  const atSelected = Math.min(atIx, Math.max(at.length - 1, 0))
  const pendingCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return
    input.current?.setSelectionRange(pendingCaret.current, pendingCaret.current)
    setCaret(pendingCaret.current)
    pendingCaret.current = null
  })
  const enter = (to: AtLevel): void => {
    if (!atQuery) return
    // The typed word goes; what follows filters the new level.
    const next = `${text.slice(0, atQuery.start)}@${text.slice(caret)}`
    setText(next)
    pendingCaret.current = atQuery.start + 1
    setAtLevel(to)
    setAtIx(to === 'top' ? 0 : 1)
  }
  /** Picks a row of the `@` menu: opens a sub-list, sets the chip, or starts the skill. */
  const pickAt = (index = atSelected): void => {
    const row = at[index]
    if (!row || !atQuery) return
    const item = row.item
    if (item.kind === 'computer-menu') return enter('computer')
    if (item.kind === 'back') return enter('top')
    const before = text.slice(0, atQuery.start)
    const after = text.slice(caret)
    if (item.kind === 'computer') {
      const joined =
        before.endsWith(' ') && after.startsWith(' ') ? before + after.slice(1) : before + after
      setBox((b) => ({ key: b.key, text: joined, computer: item.mode }))
      pendingCaret.current = before.length
    } else {
      const rest = (before + after).trim()
      setText(`/${item.command} ${rest}`.trimEnd() + ' ')
      pendingCaret.current = `/${item.command} ${rest}`.trimEnd().length + 1
    }
    setAtIx(0)
    input.current?.focus()
  }
  const atRowsView: MenuRow[] = at.map((r) => ({
    key: r.key,
    title: r.title,
    description: r.description,
    ...(r.section ? { section: r.section } : {}),
    ...(r.children ? { chevron: true } : {}),
    ...(r.item.kind === 'computer-menu' || r.item.kind === 'computer'
      ? { icon: <IconDeviceDesktop size={16} /> }
      : r.item.kind === 'back'
        ? { icon: <IconChevronLeft size={16} /> }
        : {}),
  }))
  const slashRowsView: MenuRow[] = slash.hits.map((c) => ({
    key: c.name,
    title: `${slash.prefix}${c.name}`,
    description: c.description,
    hint: c.hint,
    ...(c.subcommands.length > 0 ? { chevron: true } : {}),
  }))

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

  // Text another surface queued for this pane (Commit & push): appended for Isaac to send.
  useEffect(() => {
    const take = (): void => {
      const fill = takeComposerFill(paneId)
      if (fill === null) return
      setText((cur) => (cur.trim() === '' ? fill : `${cur.trimEnd()}\n\n${fill}`))
      input.current?.focus()
    }
    take()
    return composerFillStore.subscribe(take)
  }, [paneId])

  const abort = async (): Promise<void> => {
    await invoke('chat.abort', { paneId })
  }

  // Escape never aborts on its own. The first press (after anything open has closed) blurs the
  // composer and arms a stop for ABORT_WINDOW_MS; a second press inside it aborts. Cmd+. aborts
  // at once. The router handles Escape in capture phase; claim it ahead of sidebar Back only
  // while this composer has focus or a stop is armed. Modal/popover dismissers keep priority.
  const [armed, setArmed] = useState(false)
  const armedRef = useRef(false)
  const armTimer = useRef<number | null>(null)
  const disarm = (): void => {
    if (armTimer.current) clearTimeout(armTimer.current)
    armTimer.current = null
    armedRef.current = false
    setArmed(false)
  }
  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current)
    },
    [],
  )
  useEffect(() => {
    if (!running && armedRef.current) disarm()
  }, [running])
  useDismissable(
    DISMISS_PRIORITY.subPageBack + 1,
    () => {
      if (running && armedRef.current) {
        disarm()
        void abort()
        return
      }
      input.current?.blur()
      if (!running) return
      armedRef.current = true
      setArmed(true)
      armTimer.current = window.setTimeout(disarm, ABORT_WINDOW_MS)
      notifications.hide(STOP_TOAST_ID)
      notifications.show({
        id: STOP_TOAST_ID,
        message: 'Press Esc again to stop',
        autoClose: ABORT_WINDOW_MS + 500,
      })
    },
    focused || (running && armed),
  )
  // Cmd+. stops the reply from this pane, or from nowhere in particular (focus on the page body).
  useEffect(() => {
    if (!running) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.key !== '.') return
      const at = document.activeElement
      if (at && at !== document.body && !root.current?.contains(at)) return
      e.preventDefault()
      e.stopPropagation()
      disarm()
      void abort()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [running, paneId])
  // An open `/` menu takes Escape ahead of the stop above.
  useDismissable(
    DISMISS_PRIORITY.subPageBack + 2,
    () => {
      setSlashHidden(true)
      setAtHidden(true)
    },
    focused && (slash.hits.length > 0 || at.length > 0),
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
    const typed = draft ? text.trim() : ''
    const sentChip = draft ? computer : null
    const value = draft ? withChip(sentChip, typed) : reply.trim()
    if (draft && sentChip !== null && typed === '') return
    const sending = draft ? images : []
    if ((value === '' && sending.length === 0) || disabled) return
    const sentKey = box.key
    if (draft) {
      // Clears the saved draft too (the save effect sees the empty text).
      setBox((b) => ({ key: b.key, text: '', computer: null }))
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
        // Give the prompt back unless something new was typed meanwhile. Another chat showing
        // by now gets nothing: the prompt goes back to its own chat's saved draft.
        if (boxRef.current.key === sentKey) {
          setBox((b) =>
            b.text === '' && b.computer === null
              ? { key: b.key, text: typed, computer: sentChip }
              : b,
          )
        } else if (sentKey && draftText(sentKey) === '') saveDraft(sentKey, value)
        setImages((current) => [...sending, ...current])
      }
      if (r.error.code === 'owned-elsewhere') {
        pendingReply.current = draft ? null : value
        setWriterPrompt(r.error.message)
      } else chatStore.getState().setError(paneId, r.error.message)
    }
  }

  useImperativeHandle(ref, () => ({ sendReply: (reply) => void send(false, reply) }))

  const edit = (value: string, caretAt: number): void => {
    setText(value)
    setCaret(caretAt)
    setSlashIx(0)
    setAtIx(atLevel === 'computer' ? 1 : 0)
    setSlashHidden(false)
    setAtHidden(false)
    // Dismissed, not cleared: main keeps its error until the next prompt, and a resync in
    // between must not bring the banner back.
    if (hasError) chatStore.getState().dismissError(paneId)
  }

  return (
    <div
      ref={root}
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
            rows={slashRowsView}
            selected={slashSelected}
            onPick={(i) => completeSlash(false, i)}
          />
        ) : at.length > 0 ? (
          <SlashMenu
            rows={atRowsView}
            selected={atSelected}
            onPick={(i) => pickAt(i)}
            label="Mentions"
            testid="at-menu"
          />
        ) : null}
        <ImageChips chips={images} onRemove={remove} />
        <div className="eva-composer-line">
          {computer ? (
            <ComputerChip
              mode={computer}
              onMode={(m) => {
                setComputer(m)
                input.current?.focus()
              }}
              onRemove={() => {
                setComputer(null)
                input.current?.focus()
              }}
            />
          ) : null}
          <Textarea
            autosize
            ref={input}
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
                : computer
                  ? 'What should Computer do?'
                  : 'Ask anything, / for commands, @ for Computer and skills'
            }
            disabled={disabled}
            value={text}
            onChange={(e) => edit(e.currentTarget.value, e.currentTarget.selectionStart)}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              const sel = e.currentTarget
              if (
                e.key === 'Backspace' &&
                computer &&
                sel.selectionStart === 0 &&
                sel.selectionEnd === 0
              ) {
                e.preventDefault()
                setComputer(null)
                return
              }
              if (at.length > 0) {
                const n = at.length
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  setAtIx((atSelected + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
                  return
                }
                if (e.key === 'ArrowRight' && at[atSelected]?.children) {
                  e.preventDefault()
                  pickAt()
                  return
                }
                if (e.key === 'ArrowLeft' && atLevel !== 'top') {
                  e.preventDefault()
                  enter('top')
                  return
                }
                // A bare `@computer` is already typed out in full: Enter sends it (the help text).
                const typedOut = atLevel === 'top' && atQuery?.query.toLowerCase() === 'computer'
                if (
                  (e.key === 'Tab' && !e.shiftKey) ||
                  (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !typedOut)
                ) {
                  e.preventDefault()
                  pickAt()
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  setAtHidden(true)
                  return
                }
              }
              if (slash.hits.length > 0) {
                const n = slash.hits.length
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSlashIx((slashSelected + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
                  return
                }
                if (
                  (e.key === 'Tab' && !e.shiftKey) ||
                  (e.key === 'ArrowRight' &&
                    (slash.hits[slashSelected]?.subcommands.length ?? 0) > 0)
                ) {
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
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
          />
        </div>
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
            <Tooltip label={STOP_TOOLTIP} openDelay={400}>
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
            </Tooltip>
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
