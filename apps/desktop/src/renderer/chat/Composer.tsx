import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Textarea } from '@mantine/core'
import { IconArrowUp, IconPhoto, IconPlayerStopFilled } from '@tabler/icons-react'
import { invoke } from '../ipc'
import { chatStore, useChatStore } from './chat-store'
import { WriterPrompt } from './WriterPrompt'
import { ImageChips } from './composer/ImageChips'
import { Toolbar } from './composer/Toolbar'
import { useLaunchState } from './composer/useLaunchState'
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_PROMPT_IMAGES,
  readImageFiles,
  type ReadImage,
} from './composer/image-input'
import './composer/composer.css'

type Attached = ReadImage & { id: string }

const NOTICE = {
  'not-image': 'Only images can be attached.',
  'too-large': 'Images must be 20 MB or smaller.',
  'too-many': `You can attach up to ${MAX_PROMPT_IMAGES} images.`,
  'no-images': 'This model does not accept images.',
} as const

const hasFiles = (e: React.DragEvent): boolean =>
  Array.from(e.dataTransfer?.types ?? []).includes('Files')

/**
 * Composer: Enter sends (a send while a reply runs is a steer), Shift+Enter inserts a newline.
 * Stop and Escape abort the running turn. Images arrive by paste, drop or the attach button.
 */
export function Composer({ paneId, disabled }: { paneId: string; disabled: boolean }) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<Attached[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  /** Set while the shared writer prompt is open: main's message for why it asked. */
  const [writerPrompt, setWriterPrompt] = useState<string | null>(null)
  const dragDepth = useRef(0)
  const nextId = useRef(0)
  const picker = useRef<HTMLInputElement>(null)
  const imagesRef = useRef(images)
  imagesRef.current = images
  const running = useChatStore((s) => s.panes[paneId]?.running ?? false)
  const stopped = useChatStore((s) => s.panes[paneId]?.stopped ?? false)
  const launch = useLaunchState(paneId, !disabled)
  const imagesBlocked = launch.state !== null && !launch.state.imagesAllowed
  const hasError = useChatStore((s) => (s.panes[paneId]?.error ?? null) !== null)

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

  const attach = async (files: File[]): Promise<void> => {
    if (disabled || files.length === 0) return
    if (imagesBlocked) {
      setNotice(NOTICE['no-images'])
      return
    }
    const room = MAX_PROMPT_IMAGES - imagesRef.current.length
    const read = await readImageFiles(files)
    const kept = read.images.slice(0, Math.max(room, 0))
    for (const extra of read.images.slice(kept.length)) URL.revokeObjectURL(extra.previewUrl)
    setNotice(
      read.rejected
        ? NOTICE[read.rejected]
        : read.images.length > kept.length
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

  const send = async (force = false): Promise<void> => {
    const value = text.trim()
    if ((value === '' && images.length === 0) || disabled) return
    const sending = images
    setText('')
    setImages([])
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
      // Give the prompt back unless something new was typed meanwhile.
      setText((current) => (current === '' ? value : current))
      setImages((current) => [...sending, ...current])
      if (r.error.code === 'owned-elsewhere') setWriterPrompt(r.error.message)
      else chatStore.getState().setError(paneId, r.error.message)
    }
  }

  const edit = (value: string): void => {
    setText(value)
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
      {dragging ? <div className="eva-composer-drop">Drop images to attach</div> : null}
      <ImageChips chips={images} onRemove={remove} />
      <Textarea
        autosize
        minRows={2}
        maxRows={8}
        className="eva-composer-field"
        data-testid="composer-input"
        aria-label="Message"
        placeholder={
          disabled || stopped
            ? 'Session is not running. Resume it to send a message.'
            : 'Message Eva'
        }
        disabled={disabled}
        value={text}
        onChange={(e) => edit(e.currentTarget.value)}
        onKeyDown={(e) => {
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
              size={28}
              variant="subtle"
              aria-label="Attach image"
              aria-disabled={disabled || imagesBlocked}
              disabled={disabled || imagesBlocked}
              onClick={() => picker.current?.click()}
            >
              <IconPhoto size={16} />
            </ActionIcon>
          </>
        }
      >
        {running ? (
          <ActionIcon
            size={28}
            variant="default"
            data-testid="composer-stop"
            aria-label="Stop response"
            onClick={() => void abort()}
          >
            <IconPlayerStopFilled size={14} />
          </ActionIcon>
        ) : null}
        <ActionIcon
          size={28}
          variant="filled"
          data-testid="composer-send"
          aria-label="Send message"
          disabled={!canSend}
          onClick={() => void send()}
        >
          <IconArrowUp size={16} />
        </ActionIcon>
      </Toolbar>
      <WriterPrompt
        opened={writerPrompt !== null}
        message={writerPrompt ?? ''}
        onCancel={() => setWriterPrompt(null)}
        onConfirm={() => {
          setWriterPrompt(null)
          void send(true)
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
