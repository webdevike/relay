import '../chat/chat.css'
import '../chat/cards/cards.css'
import { useEffect, useState } from 'react'
import { Select, Switch } from '@mantine/core'
import { ChatLog } from '../chat/ChatLog'
import { Composer } from '../chat/Composer'
import { chatStore, useChatStore } from '../chat/chat-store'
import { ExtensionUiCard } from '../chat/cards/ExtensionUiCard'
import { QuestionCard } from '../chat/cards/QuestionCard'
import { JobsStrip } from '../chat/strips/JobsStrip'
import { SubagentChips } from '../chat/strips/SubagentChips'
import { settingsStore, startSettings } from '../settings/settings-store'
import {
  GALLERY_DIALOGS,
  GALLERY_FILE,
  loadGallery,
  type Gallery,
  type GalleryDialogKey,
} from './chat-gallery'

/** A pane id main never uses, so nothing it streams can reach the gallery. */
export const GALLERY_PANE = 'test-bench-gallery'

type CardKey = GalleryDialogKey | 'dead' | 'none'

const CARDS: Array<{ value: CardKey; label: string }> = [
  { value: 'none', label: 'No card' },
  { value: 'ask', label: 'Ask, one question' },
  { value: 'askMulti', label: 'Ask, two questions' },
  { value: 'select', label: 'Select' },
  { value: 'confirm', label: 'Confirm' },
  { value: 'input', label: 'Input' },
  { value: 'editor', label: 'Editor' },
  { value: 'dead', label: 'Unanswerable question' },
]

/** Answers go nowhere: the card re-arms, exactly as after a stale answer. */
const noAnswer = (): Promise<boolean> => Promise.resolve(false)

function GalleryCard({ card }: { card: CardKey }) {
  if (card === 'none') return null
  const dialog = card === 'dead' ? GALLERY_DIALOGS.ask : GALLERY_DIALOGS[card]
  return (
    <div className="eva-pending-dialog" data-testid="pending-dialog-slot">
      {dialog.kind === 'select' || dialog.kind === 'ask' ? (
        <QuestionCard key={card} dialog={dialog} dead={card === 'dead'} onAnswer={noAnswer} />
      ) : (
        <ExtensionUiCard key={card} dialog={dialog} onAnswer={noAnswer} />
      )}
    </div>
  )
}

/**
 * Show thinking and Show tool details for the gallery only. The chat log reads the Settings > Chat
 * store, so the gallery sets it in memory while it is shown (never saved) and puts the loaded
 * values back when it closes.
 */
function useGallerySettings(thinking: boolean, tools: boolean): void {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let live = true
    let previous: { show_thinking: boolean; show_tools: boolean } | null = null
    void startSettings().then(() => {
      if (!live) return
      const { show_thinking, show_tools } = settingsStore.getState()
      previous = { show_thinking, show_tools }
      setReady(true)
    })
    return () => {
      live = false
      if (previous) settingsStore.setState(previous)
    }
  }, [])
  useEffect(() => {
    if (ready) settingsStore.setState({ show_thinking: thinking, show_tools: tools })
  }, [ready, thinking, tools])
}

let parsed: Gallery | null = null
/** Parsed once per app run, so reopening the gallery hands the log the same rows. */
const galleryData = (): Gallery => (parsed ??= loadGallery())

/** The gallery session rendered by the real chat log, cards, strips and composer. Nothing is sent. */
export function ChatGallery() {
  const gallery = galleryData()
  const [thinking, setThinking] = useState(true)
  const [tools, setTools] = useState(true)
  const [card, setCard] = useState<CardKey>('none')
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [opened, setOpened] = useState(false)
  useGallerySettings(thinking, tools)

  // Each visit opens the pane afresh, so pin state left from the last visit never shows.
  useEffect(() => {
    chatStore.getState().openPane(GALLERY_PANE, {
      file: GALLERY_FILE,
      title: gallery.title,
      messages: gallery.messages,
      meta: gallery.meta,
    })
    setOpened(true)
  }, [gallery])
  const messages = useChatStore((s) => (opened ? (s.panes[GALLERY_PANE]?.messages ?? null) : null))

  return (
    <section className="bench-gallery" aria-label="Chat gallery" data-testid="chat-gallery">
      <p className="bench-muted">
        A saved session that uses every kind of chat row, drawn by the same components as a real
        chat. Nothing here reaches omp. Light and dark follow the app theme.
      </p>
      <div className="bench-gallery-controls">
        <Switch
          label="Show thinking"
          checked={thinking}
          onChange={(e) => setThinking(e.currentTarget.checked)}
          data-testid="gallery-show-thinking"
        />
        <Switch
          label="Show tool details"
          checked={tools}
          onChange={(e) => setTools(e.currentTarget.checked)}
          data-testid="gallery-show-tools"
        />
        <Select
          label="Card above the composer"
          value={card}
          onChange={(v) => setCard((v as CardKey | null) ?? 'none')}
          data={CARDS}
          allowDeselect={false}
          data-testid="gallery-card"
        />
      </div>
      <div className="eva-chat bench-gallery-chat" data-testid="chat-gallery-frame">
        <div className="eva-chat-header">
          <h2 className="eva-heading eva-chat-title">{gallery.title}</h2>
          <span className="eva-chat-saved">Saved session</span>
        </div>
        {messages ? (
          <ChatLog paneId={GALLERY_PANE} messages={messages} file={GALLERY_FILE} />
        ) : null}
        <SubagentChips
          subagents={gallery.subagents}
          hidden={hidden}
          onClearDone={() =>
            setHidden(new Set(gallery.subagents.filter((s) => s.done).map((s) => s.name)))
          }
        />
        <GalleryCard card={card} />
        <JobsStrip running jobs={gallery.jobs} />
        <Composer paneId={GALLERY_PANE} disabled />
      </div>
    </section>
  )
}
