import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Button, Loader, Textarea } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconExternalLink,
  IconFile,
  IconHash,
  IconLock,
  IconMessage,
  IconQuote,
  IconRefresh,
} from '@tabler/icons-react'
import type { SlackMessage, SlackQueue, SlackRow, SlackThread } from '@evaos/contract'
import { emojify, reactionEmoji } from '@relay/slack-emoji'
import { invoke } from '../ipc'
import { openLink } from '../navigation/open-link'
import { EvaModal } from '../overlay'
import { Markdown } from '../chat/markdown/Markdown'
import { MarkdownMedia } from '../chat/markdown/MarkdownMedia'
import { quoteOf } from './LinearDetail'
import { ago, agoPhrase, mentionsAstra } from './review-model'
import { Avatar, fail, useLocal } from './review-ui'
import { AstraThreadView, threadPropsOf, useAstraItem } from './AstraInline'
import { mergeTimeline, threadReplyText } from './astra-timeline'
import { slackContext } from './astra-context'

/** The Slack queue as the page holds it: the last read, whether a fresh one is running, its error. */
export interface SlackState {
  queue: SlackQueue | null
  reading: boolean
  error: string | null
}

/** A reply handed to Astra to post; shown under the thread until Slack has it. */
interface PendingSend {
  text: string
  at: number
  status: 'sent' | 'dry-run'
}

const isDone = (r: SlackRow, done: Record<string, number>): boolean =>
  done[r.url] !== undefined && r.updatedAt <= done[r.url]!

/** `#ui-ux` stays; a DM is the person's name. */
const where = (r: { channelName: string }): string => r.channelName

/** Mentions (DMs count: they are to him) and Replies, like the Slack design's Threads queue. */
export function SlackGroups({
  slack,
  done,
  selected,
  onOpen,
  onRefresh,
  now,
}: {
  slack: SlackState
  done: Record<string, number>
  selected: string | null
  onOpen: (r: SlackRow) => void
  onRefresh: () => void
  now: number
}) {
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const rows = (slack.queue?.rows ?? []).filter((r) => !isDone(r, done))
  const groups = [
    { id: 'mentions', label: 'Slack mentions', rows: rows.filter((r) => r.kind !== 'reply') },
    { id: 'replies', label: 'Slack replies', rows: rows.filter((r) => r.kind === 'reply') },
  ]
  return (
    <div data-testid="review-slack-groups">
      {groups.map((g, gi) => (
        <div key={g.id} className="eva-rv-group">
          <span className="eva-rv-group-headrow">
            <button
              type="button"
              className="eva-rv-group-head"
              onClick={() => setClosed({ ...closed, [g.id]: !closed[g.id] })}
            >
              {g.label} <span className="eva-rv-dim">{slack.queue ? g.rows.length : ''}</span>
              {closed[g.id] ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
            </button>
            {gi === 0 ? (
              slack.reading ? (
                <span
                  className="eva-rv-dim eva-rv-small eva-rv-reading"
                  data-testid="review-slack-reading"
                >
                  <Loader size={10} /> reading
                </span>
              ) : (
                <button
                  type="button"
                  className="eva-rv-iconbtn"
                  aria-label="Read Slack again"
                  title={
                    slack.queue ? `Read ${agoPhrase(slack.queue.fetchedAt, now)}` : 'Read Slack'
                  }
                  onClick={onRefresh}
                >
                  <IconRefresh size={12} />
                </button>
              )
            ) : null}
          </span>
          {closed[g.id] ? null : slack.queue === null ? (
            gi === 0 ? (
              <div className="eva-rv-dim eva-rv-pad">
                {slack.error ? `Couldn't read Slack: ${slack.error}` : 'Reading Slack...'}
              </div>
            ) : null
          ) : g.rows.length === 0 ? (
            <div className="eva-rv-dim eva-rv-pad">Nothing here.</div>
          ) : (
            g.rows.map((r) => (
              <button
                key={r.url}
                type="button"
                className="eva-rv-qrow"
                data-active={selected === r.url || undefined}
                data-testid="review-slack-row"
                data-thread={r.threadTs ? true : undefined}
                onClick={() => onOpen(r)}
                title={`${where(r)}: ${emojify(r.text)}`}
              >
                <span className="eva-rv-qrow-line">
                  <span className="eva-rv-qrow-title">
                    {where(r)}
                    {r.threadTs && r.kind === 'reply' ? ' thread' : ''}
                  </span>
                </span>
                <span className="eva-rv-qrow-line eva-rv-dim">
                  <span className="eva-rv-qrow-sub">{emojify(r.text)}</span>
                  <Avatar login={r.author || '?'} />
                  <span>{ago(r.updatedAt, now)}</span>
                </span>
              </button>
            ))
          )}
        </div>
      ))}
      {slack.queue && slack.error ? (
        <div className="eva-rv-dim eva-rv-pad">Last read failed: {slack.error}</div>
      ) : null}
    </div>
  )
}

/** `Today at 14:09`, `Oct 28 at 09:12`. */
function stamp(at: number, now: number): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (new Date(now).toDateString() === d.toDateString()) return `Today at ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`
}

/** The text selected inside `el`, or null when the selection is elsewhere or empty. */
function selectionIn(el: HTMLElement | null): string | null {
  const sel = window.getSelection()
  if (!el || !sel || sel.isCollapsed || !sel.anchorNode || !el.contains(sel.anchorNode)) return null
  return sel.toString().trim() || null
}

function MessageView({
  m,
  now,
  link,
  onQuote,
}: {
  m: SlackMessage
  now: number
  /** Where "Open in Slack" goes for a file shown as a chip. */
  link: string
  onQuote: (text: string) => void
}) {
  const body = useRef<HTMLDivElement>(null)
  return (
    <div
      className="eva-rv-smsg"
      data-mention={m.mentionsMe || undefined}
      data-testid="slack-message"
    >
      {m.mentionsMe ? <div className="eva-rv-lmention">Mentions you</div> : null}
      <div className="eva-rv-smsg-row">
        <span className="eva-rv-savatar">
          <Avatar login={m.author || '?'} />
        </span>
        <div className="eva-rv-smsg-main">
          <div className="eva-rv-comment-head">
            <b>{m.author}</b>
            <span className="eva-rv-dim eva-rv-small">{stamp(m.at, now)}</span>
            <span className="eva-rv-spacer" />
            <span className="eva-rv-lcomment-actions">
              <button
                type="button"
                className="eva-rv-iconbtn"
                aria-label="Quote"
                title="Quote the selected text (or the whole message)"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onQuote(selectionIn(body.current) ?? m.text)}
              >
                <IconQuote size={14} />
              </button>
            </span>
          </div>
          <div ref={body} className="eva-rv-smsg-body">
            <Markdown text={emojify(m.text)} />
          </div>
          {m.files.some((f) => f.image) ? (
            <div className="eva-rv-simages" data-testid="slack-images">
              {m.files.flatMap((f) =>
                f.image ? [<MarkdownMedia key={f.id || f.name} src={f.image} alt={f.name} />] : [],
              )}
            </div>
          ) : null}
          {m.files.some((f) => !f.image) ? (
            <div className="eva-rv-labels">
              {m.files.flatMap((f) =>
                f.image
                  ? []
                  : [
                      <button
                        key={f.id || f.name}
                        type="button"
                        className="eva-rv-sfile"
                        title="Open in Slack"
                        onClick={() => openLink(link)}
                      >
                        <IconFile size={13} className="eva-rv-dim" />
                        {f.name}
                        <IconExternalLink size={11} className="eva-rv-dim" />
                      </button>,
                    ],
              )}
            </div>
          ) : null}
          {m.reactions.length > 0 ? (
            <div className="eva-rv-labels">
              {m.reactions.map((r) => (
                <span key={r.emoji} className="eva-rv-sreact">
                  {reactionEmoji(r.emoji)} {r.count}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/**
 * One Slack thread (or a DM's recent messages) in the E3 page shell, chat style: the parent, an
 * "N replies" divider, the replies, "Mentions you" on messages that @mention Isaac. The reply box
 * sends to Slack through Astra after Isaac confirms the exact text; @Astra makes it a private ask.
 */
export function SlackDetail({
  row,
  now,
  onBack,
  onDone,
}: {
  row: SlackRow
  now: number
  onBack: () => void
  onDone: () => void
}) {
  const ref = { channel: row.channel, threadTs: row.threadTs }
  const [thread, setThread] = useState<SlackThread | null>(null)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const astra = useAstraItem(row.url)
  const [pending, setPending] = useLocal<PendingSend[]>(`eva-reviews-slack-sent:${row.url}`, [])
  const [draft, setDraft] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The last read shows at once; a fresh read replaces it when Slack answers.
  const refresh = useCallback(async () => {
    setReading(true)
    setError(null)
    const r = await invoke('reviews.slackThread', { ...ref, refresh: true })
    setReading(false)
    if (r.ok && r.value) setThread(r.value)
    else if (!r.ok) setError(r.error.message)
  }, [row.url])
  useEffect(() => {
    let live = true
    void invoke('reviews.slackThread', { ...ref, refresh: false }).then((r) => {
      if (live && r.ok && r.value) setThread(r.value)
    })
    void refresh()
    return () => {
      live = false
    }
  }, [refresh])

  const title = thread?.channelName ?? row.channelName
  const parent = row.threadTs ? thread?.messages[0] : undefined
  const rest = parent ? thread!.messages.slice(1) : (thread?.messages ?? [])
  const timeline = mergeTimeline(rest, (m) => m.at, astra.threads)
  const threadProps = threadPropsOf(astra)
  // Sends Slack has not shown back yet (by exact text, after the send).
  const waiting = pending.filter(
    (p) =>
      !thread?.messages.some(
        (m) => m.mine && m.at >= p.at - 60_000 && m.text.trim() === p.text.trim(),
      ),
  )

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    if (mentionsAstra(text)) {
      setBusy(true)
      const label = `Slack ${title}`
      if (await astra.ask(text, label, () => slackContext(row, thread))) setDraft('')
      setBusy(false)
      return
    }
    setConfirm(text)
  }

  const handOff = async (): Promise<void> => {
    if (confirm === null) return
    setBusy(true)
    const r = await invoke('reviews.slackSend', { ...ref, text: confirm })
    setBusy(false)
    if (!r.ok) return fail("Couldn't reach Astra", r.error.message)
    setPending([...pending, { text: confirm, at: Date.now(), status: r.value.status }])
    setConfirm(null)
    setDraft('')
    notifications.show({
      message:
        r.value.status === 'sent'
          ? 'Sent to Astra to post in Slack.'
          : `Test instance, not sent: ${r.value.command}`,
      color: r.value.status === 'sent' ? 'green' : 'gray',
    })
  }

  return (
    <section className="eva-rv-detail" data-testid="slack-detail">
      <header className="eva-rv-topbar">
        <button type="button" className="eva-rv-back" onClick={onBack}>
          <IconChevronLeft size={14} /> Inbox
        </button>
        <span className="eva-rv-dim eva-rv-small eva-rv-ellipsis">{title}</span>
        <span className="eva-rv-spacer" />
        <span className="eva-rv-dim eva-rv-small">
          {reading ? (
            <span className="eva-rv-reading" data-testid="slack-reading">
              <Loader size={10} /> reading Slack
            </span>
          ) : thread ? (
            `updated ${agoPhrase(thread.fetchedAt, now)}`
          ) : null}
        </span>
        <button
          type="button"
          className="eva-rv-iconbtn"
          aria-label="Refresh"
          disabled={reading}
          onClick={() => void refresh()}
        >
          <IconRefresh size={14} />
        </button>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconCheck size={14} />}
          onClick={onDone}
          data-testid="review-done"
        >
          Done
        </Button>
        <button
          type="button"
          className="eva-rv-iconbtn"
          aria-label="Open in Slack"
          onClick={() => openLink(row.url)}
        >
          <IconExternalLink size={14} />
        </button>
      </header>
      <div className="eva-rv-head">
        <div className="eva-rv-titlerow">
          {row.kind === 'dm' ? (
            <IconMessage size={15} className="eva-rv-dim" />
          ) : (
            <IconHash size={15} className="eva-rv-dim" />
          )}
          <h1 className="eva-rv-title eva-rv-ellipsis">
            {parent ? firstLine(emojify(parent.text)) : title}
          </h1>
        </div>
        <div className="eva-rv-meta">
          <span>{title}</span>·
          <span>
            {row.kind === 'mention'
              ? `${row.author} mentioned you`
              : row.kind === 'dm'
                ? `${row.author} wrote to you`
                : `${row.author} replied`}
          </span>
          ·<span>{agoPhrase(row.updatedAt, now)}</span>
        </div>
      </div>
      <div className="eva-rv-main">
        <div className="eva-rv-content">
          <div className="eva-rv-scroll">
            <div className="eva-rv-conv" data-testid="slack-thread">
              {!thread ? (
                <div className="eva-rv-dim">
                  {error ? `Couldn't read Slack: ${error}` : 'Reading the thread from Slack...'}
                </div>
              ) : (
                <>
                  {error ? (
                    <div className="eva-rv-error eva-rv-small">Last read failed: {error}</div>
                  ) : null}
                  {parent ? (
                    <MessageView
                      m={parent}
                      now={now}
                      link={row.url}
                      onQuote={(t) => setDraft((d) => d + quoteOf(t))}
                    />
                  ) : null}
                  {parent && rest.length > 0 ? (
                    <div className="eva-rv-sdivider">
                      {rest.length} {rest.length === 1 ? 'reply' : 'replies'}
                    </div>
                  ) : null}
                  {timeline.map((e) =>
                    e.kind === 'astra' ? (
                      <AstraThreadView
                        key={`astra-${e.thread.id}`}
                        {...threadProps(e.thread)}
                        now={now}
                        look="slack"
                        onReply={(root, text) =>
                          astra.ask(threadReplyText(root, text), `Slack ${title}`, () =>
                            slackContext(row, thread),
                          )
                        }
                        onUseAsReply={setDraft}
                      />
                    ) : (
                      <Fragment key={e.item.ts}>
                        <MessageView
                          m={e.item}
                          now={now}
                          link={row.url}
                          onQuote={(t) => setDraft((d) => d + quoteOf(t))}
                        />
                      </Fragment>
                    ),
                  )}
                  {waiting.map((p, i) => (
                    <div key={i} className="eva-rv-spending" data-testid="slack-pending-send">
                      <div className="eva-rv-private-head">
                        <IconClock size={13} />
                        {p.status === 'sent'
                          ? 'Sent to Astra to post'
                          : 'Test instance: not sent to Astra'}
                        <span className="eva-rv-dim">{agoPhrase(p.at, now)}</span>
                      </div>
                      <div className="eva-rv-private-q">{p.text}</div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
          <div className="eva-rv-composer">
            <Textarea
              autosize
              minRows={2}
              maxRows={10}
              value={draft}
              placeholder={
                row.threadTs
                  ? 'Reply in thread. Type @Astra to ask Astra privately.'
                  : `Message ${title}. Type @Astra to ask Astra privately.`
              }
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void send()
                }
              }}
              data-private={mentionsAstra(draft) || undefined}
              data-testid="slack-composer"
            />
            <div className="eva-rv-composer-foot">
              <span className="eva-rv-dim eva-rv-small">
                {mentionsAstra(draft) ? (
                  <>
                    <IconLock size={11} /> Private to Astra, never sent to Slack
                  </>
                ) : (
                  `Cmd+Enter · Astra posts it ${row.threadTs ? 'in the thread' : 'in the DM'} for you`
                )}
              </span>
              <span className="eva-rv-spacer" />
              <Button
                size="xs"
                variant="subtle"
                disabled={!draft.trim() || busy || astra.asking}
                onClick={() => void send()}
              >
                {mentionsAstra(draft) ? 'Ask Astra' : 'Send'}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <EvaModal
        opened={confirm !== null}
        onClose={() => setConfirm(null)}
        title={row.threadTs ? 'Send this reply in Slack?' : 'Send this message in Slack?'}
        size={480}
      >
        <div className="eva-rv-confirm-text" data-testid="review-confirm-text">
          {confirm}
        </div>
        <div className="eva-rv-dim eva-rv-small">
          Astra posts it as you{' '}
          {row.threadTs ? `in the thread in ${title}` : `in your conversation with ${title}`},
          exactly as written, from the Slack app.
        </div>
        <div className="eva-rv-modal-actions">
          <Button variant="default" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void handOff()} data-testid="review-confirm-post">
            Send to Astra to post
          </Button>
        </div>
      </EvaModal>
    </section>
  )
}

/** A message's first line without Markdown marks, for the page title. */
function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .find((l) => l.trim())
      ?.replace(/[*_`>#]/g, '')
      .trim() ?? ''
  )
}
