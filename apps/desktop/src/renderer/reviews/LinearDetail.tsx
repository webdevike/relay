import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Textarea } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconArrowBackUp,
  IconCheck,
  IconChevronLeft,
  IconExternalLink,
  IconGitPullRequest,
  IconLock,
  IconQuote,
  IconRefresh,
} from '@tabler/icons-react'
import type { LinearComment, LinearRow, LinearTicket } from '@evaos/contract'
import { invoke } from '../ipc'
import { openLink } from '../navigation/open-link'
import { EvaModal } from '../overlay'
import { Markdown } from '../chat/markdown/Markdown'
import { agoPhrase, mentionsAstra } from './review-model'
import { Avatar, RailSection, SourceMark, fail } from './review-ui'
import { AstraThreadView, threadPropsOf, useAstraItem } from './AstraInline'
import { mergeTimeline, threadReplyText } from './astra-timeline'
import { ticketContext } from './astra-context'

type Tab = 'details' | 'comments'

interface Person {
  name: string
  handle: string
  /** Profile page: the mention Linear understands. Empty for Astra, who is never posted. */
  url: string
}

/**
 * The body Linear gets: each `@Name` of a person on the ticket becomes a link to their profile,
 * which Linear renders and notifies as a mention (plain `@handle` text is neither). Longer names
 * go first so `@Ann Lee` is not read as `@Ann`.
 */
export function linearBody(text: string, people: readonly Person[]): string {
  let out = text
  for (const p of [...people].filter((x) => x.url).sort((a, b) => b.name.length - a.name.length)) {
    const at = new RegExp(`@${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g')
    out = out.replace(at, p.url)
  }
  return out
}

/** A Linear profile link (`https://linear.app/<workspace>/profiles/<handle>`): how Linear writes a mention. */
const PROFILE = /(?<!\]\()<?https:\/\/linear\.app\/[\w-]+\/profiles\/([\w.-]+)>?/g

/**
 * What a Linear body shows: each profile link as `@<Name>` in Linear's mention style (the
 * `mention:` pill the app's Markdown renders), the name from the people on the ticket, else the
 * handle. The body itself keeps the links, so a quote or reply still mentions the person.
 */
export function linearDisplay(text: string, people: readonly Person[]): string {
  return text.replace(PROFILE, (_, handle: string) => {
    const p = people.find((x) => x.handle.toLowerCase() === handle.toLowerCase())
    const name = (p?.name ?? handle).replace(/[[\]]/g, '')
    return `[@${name}](mention:linear)`
  })
}

/** `> ` before every line: a quote in markdown. */
export function quoteOf(text: string): string {
  return `${text
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')}\n\n`
}

/** The text selected inside `el`, or null when the selection is elsewhere or empty. */
function selectionIn(el: HTMLElement | null): string | null {
  const sel = window.getSelection()
  if (!el || !sel || sel.isCollapsed || !sel.anchorNode) return null
  if (!el.contains(sel.anchorNode)) return null
  const text = sel.toString().trim()
  return text || null
}

/**
 * A comment box: @ opens a list of Astra and the people on the ticket; mentioning Astra makes it a
 * private question to her (never posted). Cmd+Enter sends.
 */
function ReplyBox({
  value,
  onChange,
  people,
  placeholder,
  target,
  busy,
  onSend,
  onCancel,
  autoFocus,
  testid,
}: {
  value: string
  onChange: (v: string) => void
  people: Person[]
  placeholder: string
  /** Where a non-private send goes, for the hint line. */
  target: string
  busy: boolean
  onSend: () => void
  onCancel?: () => void
  autoFocus?: boolean
  testid: string
}) {
  const box = useRef<HTMLTextAreaElement>(null)
  const [query, setQuery] = useState<string | null>(null)
  const priv = mentionsAstra(value)
  const options: Person[] = [
    { name: 'Astra (private)', handle: 'Astra', url: '' },
    ...people,
  ].filter(
    (p) =>
      query !== null &&
      (p.handle.toLowerCase().startsWith(query.toLowerCase()) ||
        p.name.toLowerCase().startsWith(query.toLowerCase())),
  )

  const track = (text: string, caret: number): void => {
    const m = /(^|\s)@([\w.-]*)$/.exec(text.slice(0, caret))
    setQuery(m ? m[2]! : null)
  }
  const pick = (p: Person): void => {
    const el = box.current
    const caret = el?.selectionStart ?? value.length
    // The editor shows `@Name`; linearBody turns it into the profile link Linear mentions with.
    const label = p.url ? p.name : p.handle
    const before = value.slice(0, caret).replace(/@([\w.-]*)$/, `@${label} `)
    onChange(before + value.slice(caret))
    setQuery(null)
    caretAt.current = before.length
  }
  // After a mention is picked, the caret goes right after it before the next key lands.
  const caretAt = useRef<number | null>(null)
  useLayoutEffect(() => {
    const at = caretAt.current
    if (at === null || !box.current) return
    caretAt.current = null
    box.current.focus()
    box.current.setSelectionRange(at, at)
  }, [value])

  return (
    <div className="eva-rv-replybox">
      <Textarea
        ref={box}
        autosize
        minRows={2}
        maxRows={10}
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.currentTarget.value)
          track(e.currentTarget.value, e.currentTarget.selectionStart)
        }}
        onKeyDown={(e) => {
          if (query !== null && options.length > 0 && (e.key === 'Enter' || e.key === 'Tab')) {
            e.preventDefault()
            pick(options[0]!)
            return
          }
          if (e.key === 'Escape' && query !== null) {
            e.stopPropagation()
            setQuery(null)
            return
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            onSend()
          }
        }}
        data-private={priv || undefined}
        data-testid={testid}
      />
      {query !== null && options.length > 0 ? (
        <div className="eva-rv-mentions" role="listbox" data-testid="review-mention-list">
          {options.slice(0, 6).map((p) => (
            <button
              key={p.handle}
              type="button"
              role="option"
              aria-selected={false}
              className="eva-rv-mention-opt"
              onMouseDown={(e) => {
                e.preventDefault()
                pick(p)
              }}
            >
              {p.handle === 'Astra' ? <IconLock size={12} /> : <Avatar login={p.name} />}
              <span>{p.name}</span>
              <span className="eva-rv-dim">@{p.handle}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="eva-rv-composer-foot">
        <span className="eva-rv-dim eva-rv-small" data-private={priv || undefined}>
          {priv ? (
            <>
              <IconLock size={11} /> Private to Astra, never sent to Linear
            </>
          ) : (
            `Cmd+Enter · ${target}`
          )}
        </span>
        <span className="eva-rv-spacer" />
        {onCancel ? (
          <Button size="xs" variant="subtle" color="gray" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button size="xs" variant="subtle" disabled={!value.trim() || busy} onClick={onSend}>
          {priv ? 'Ask Astra' : onCancel ? 'Reply' : 'Comment'}
        </Button>
      </div>
    </div>
  )
}

function CommentView({
  c,
  now,
  people,
  onReply,
  onQuote,
}: {
  c: LinearComment
  now: number
  /** Everyone on the ticket, Isaac too: whom a profile link names. */
  people: readonly Person[]
  onReply?: () => void
  onQuote: (text: string) => void
}) {
  const body = useRef<HTMLDivElement>(null)
  return (
    <div
      className="eva-rv-lcomment"
      data-mention={c.mentionsMe || undefined}
      data-testid="linear-comment"
    >
      {c.mentionsMe ? <div className="eva-rv-lmention">Mentions you</div> : null}
      <div className="eva-rv-comment-head">
        <Avatar login={c.author.name} />
        <b>{c.author.name}</b>
        <span className="eva-rv-dim">{agoPhrase(c.at, now)}</span>
        <span className="eva-rv-spacer" />
        <span className="eva-rv-lcomment-actions">
          <button
            type="button"
            className="eva-rv-iconbtn"
            aria-label="Quote"
            title="Quote the selected text (or the whole comment)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onQuote(selectionIn(body.current) ?? c.body)}
          >
            <IconQuote size={14} />
          </button>
          {onReply ? (
            <button
              type="button"
              className="eva-rv-iconbtn"
              aria-label="Reply"
              title="Reply under this comment"
              onClick={onReply}
            >
              <IconArrowBackUp size={14} />
            </button>
          ) : null}
        </span>
      </div>
      <div ref={body} className="eva-rv-lcomment-body">
        <Markdown text={linearDisplay(c.body, people)} />
      </div>
    </div>
  )
}

function Rail({ t }: { t: LinearTicket }) {
  const prs = t.links.filter((l) => /\/pull\/\d+/.test(l.url))
  const commits = t.links.filter((l) => /\/commit\/[0-9a-f]+/.test(l.url))
  const other = t.links.filter((l) => !prs.includes(l) && !commits.includes(l))
  return (
    <aside className="eva-rv-rail" data-testid="linear-rail">
      <RailSection title="Status">
        <span className="eva-rv-lstate">
          <span className="eva-rv-ldot" style={{ background: t.state.color }} />
          {t.state.name}
        </span>
      </RailSection>
      <RailSection title="Assignee">
        {t.assignee ? (
          <div className="eva-rv-rail-person">
            <Avatar login={t.assignee} />
            {t.assignee}
          </div>
        ) : (
          <div className="eva-rv-dim">Unassigned.</div>
        )}
      </RailSection>
      <RailSection title="Priority">
        <div className={t.priority === 'No priority' ? 'eva-rv-dim' : undefined}>{t.priority}</div>
      </RailSection>
      <RailSection title="Labels">
        {t.labels.length === 0 ? (
          <div className="eva-rv-dim">No labels.</div>
        ) : (
          <div className="eva-rv-labels">
            {t.labels.map((l) => (
              <span key={l.name} className="eva-rv-label" style={{ borderColor: l.color }}>
                {l.name}
              </span>
            ))}
          </div>
        )}
      </RailSection>
      <RailSection title="Project">
        <div className={t.project ? undefined : 'eva-rv-dim'}>{t.project ?? 'No project.'}</div>
      </RailSection>
      {t.parent ? (
        <RailSection title="Parent">
          <button type="button" className="eva-rv-raillink" onClick={() => openLink(t.parent!.url)}>
            <span className="eva-rv-mono eva-rv-dim">{t.parent.key}</span>
            <span className="eva-rv-ellipsis">{t.parent.title}</span>
          </button>
        </RailSection>
      ) : null}
      {t.children.length > 0 ? (
        <RailSection title={`Sub-issues ${t.children.length}`}>
          {t.children.map((c) => (
            <button
              key={c.key}
              type="button"
              className="eva-rv-raillink"
              onClick={() => openLink(c.url)}
              title={`${c.title} (${c.state})`}
            >
              <span className="eva-rv-mono eva-rv-dim">{c.key}</span>
              <span className="eva-rv-ellipsis">{c.title}</span>
            </button>
          ))}
        </RailSection>
      ) : null}
      <RailSection title="Linked PRs">
        {prs.length === 0 ? <div className="eva-rv-dim">No pull requests.</div> : null}
        {prs.map((l) => (
          <button
            key={l.url}
            type="button"
            className="eva-rv-raillink"
            onClick={() => openLink(l.url)}
            title={l.title}
          >
            <IconGitPullRequest size={13} className="eva-rv-ok" />
            <span className="eva-rv-ellipsis">{l.title}</span>
          </button>
        ))}
        {commits.length > 0 ? (
          <div className="eva-rv-dim eva-rv-small">
            {commits.length} linked {commits.length === 1 ? 'commit' : 'commits'}
          </div>
        ) : null}
      </RailSection>
      {other.length > 0 ? (
        <RailSection title="Links">
          {other.map((l) => (
            <button
              key={l.url}
              type="button"
              className="eva-rv-raillink"
              onClick={() => openLink(l.url)}
              title={l.url}
            >
              <IconExternalLink size={13} className="eva-rv-dim" />
              <span className="eva-rv-ellipsis">{l.title}</span>
            </button>
          ))}
        </RailSection>
      ) : null}
    </aside>
  )
}

/**
 * A Linear ticket in the E3 layout: Details (description, images inline) and Comments (threads with
 * replies, reply under a comment, quote a selection, @mentions), properties in the rail. @Astra
 * makes a comment a private question to Astra; anything for Linear shows the exact text first.
 */
export function LinearDetail({
  row,
  now,
  onBack,
  onDone,
}: {
  row: LinearRow
  now: number
  onBack: () => void
  /** Done on this ticket (its url and title as loaded). */
  onDone: (t: LinearTicket) => void
}) {
  const [ticket, setTicket] = useState<{ t: LinearTicket; at: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('details')
  const [draft, setDraft] = useState('')
  const [reply, setReply] = useState<{ to: LinearComment; text: string } | null>(null)
  const [confirm, setConfirm] = useState<{ body: string; parent: LinearComment | null } | null>(
    null,
  )
  const [busy, setBusy] = useState(false)
  const descRef = useRef<HTMLDivElement>(null)
  const astra = useAstraItem(row.url)

  const load = useCallback(async () => {
    setError(null)
    const r = await invoke('reviews.linearTicket', { key: row.key })
    if (r.ok) setTicket({ t: r.value, at: Date.now() })
    else setError(r.error.message)
  }, [row.key])
  useEffect(() => {
    setTicket(null)
    void load()
  }, [load])

  if (!ticket) {
    return (
      <div className="eva-rv-placeholder eva-rv-dim" data-testid="linear-detail-loading">
        {error ? `Couldn't load ${row.key}: ${error}` : `Loading ${row.key}...`}
      </div>
    )
  }
  const t = ticket.t
  const everyone = [...t.people, t.me]
  const roots = t.comments.filter((c) => c.parentId === null)
  const repliesTo = (id: string) => t.comments.filter((c) => c.parentId === id)
  const timeline = mergeTimeline(roots, (c) => c.at, astra.threads)
  const threadProps = threadPropsOf(astra)

  const send = async (text: string, parent: LinearComment | null): Promise<void> => {
    const body = text.trim()
    if (!body) return
    if (mentionsAstra(body)) {
      setBusy(true)
      const about = parent
        ? `(about ${parent.author.name}'s comment: "${parent.body.slice(0, 300)}") `
        : ''
      const ok = await astra.ask(`${about}${body}`, t.key, () => ticketContext(t))
      setBusy(false)
      if (ok) {
        if (parent) setReply(null)
        else setDraft('')
        // Her answer comes in the comment timeline.
        setTab('comments')
      }
      return
    }
    // The confirm shows exactly what Linear will get: mentions as profile links.
    setConfirm({ body: linearBody(body, t.people), parent })
  }

  const post = async (): Promise<void> => {
    if (!confirm) return
    setBusy(true)
    const r = await invoke('reviews.linearComment', {
      issueId: t.id,
      parentId: confirm.parent?.id ?? null,
      body: confirm.body,
    })
    setBusy(false)
    const parent = confirm.parent
    setConfirm(null)
    if (!r.ok) {
      return fail(r.error.code === 'dry-run' ? 'Not posted' : "Couldn't post it", r.error.message)
    }
    if (parent) setReply(null)
    else setDraft('')
    notifications.show({ message: 'Posted on Linear.', color: 'green' })
    void load()
  }

  const quote = (text: string, thread: LinearComment | null): void => {
    if (thread) {
      setReply((r) => ({
        to: thread,
        text: `${r && r.to.id === thread.id ? r.text : ''}${quoteOf(text)}`,
      }))
    } else setDraft((d) => `${d}${quoteOf(text)}`)
  }

  return (
    <section className="eva-rv-detail" data-testid="linear-detail">
      <header className="eva-rv-topbar">
        <button type="button" className="eva-rv-back" onClick={onBack}>
          <IconChevronLeft size={14} /> Inbox
        </button>
        <span className="eva-rv-spacer" />
        <span className="eva-rv-dim eva-rv-small">updated {agoPhrase(ticket.at, now)}</span>
        <button
          type="button"
          className="eva-rv-iconbtn"
          aria-label="Refresh"
          onClick={() => void load()}
        >
          <IconRefresh size={14} />
        </button>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconCheck size={14} />}
          onClick={() => onDone(t)}
          data-testid="review-done"
        >
          Done
        </Button>
        <button
          type="button"
          className="eva-rv-iconbtn"
          aria-label="Open in Linear"
          onClick={() => openLink(t.url, { reviews: false })}
        >
          <IconExternalLink size={14} />
        </button>
      </header>
      <div className="eva-rv-head">
        <div className="eva-rv-titlerow">
          <SourceMark source="linear" size={15} />
          <span className="eva-rv-ldot" style={{ background: t.state.color }} />
          <span className="eva-rv-dim eva-rv-mono">{t.key}</span>
          <h1 className="eva-rv-title">{t.title}</h1>
        </div>
        <div className="eva-rv-meta">
          <span className="eva-rv-pill" style={{ color: t.state.color }}>
            {t.state.name}
          </span>
          <span>{t.creator}</span>·<span>{agoPhrase(t.createdAt, now)}</span>·<span>{t.team}</span>
          {t.project ? (
            <>
              ·<span>{t.project}</span>
            </>
          ) : null}
        </div>
      </div>
      <nav className="eva-rv-tabs" role="tablist">
        {(['details', 'comments'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className="eva-rv-tab"
            data-testid={`linear-tab-${id}`}
            onClick={() => setTab(id)}
          >
            {id === 'details' ? 'Details' : 'Comments'}
            {id === 'comments' ? <span className="eva-rv-dim">{t.comments.length}</span> : null}
          </button>
        ))}
      </nav>
      <div className="eva-rv-main">
        <div className="eva-rv-content">
          <div className="eva-rv-scroll">
            {tab === 'details' ? (
              <div className="eva-rv-conv" data-testid="linear-details">
                <div className="eva-rv-comment-head">
                  <Avatar login={t.creator} />
                  <b>{t.creator}</b>
                  <span className="eva-rv-dim">opened this {agoPhrase(t.createdAt, now)}</span>
                  <span className="eva-rv-spacer" />
                  <button
                    type="button"
                    className="eva-rv-iconbtn"
                    aria-label="Quote"
                    title="Quote the selected text"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      const s = selectionIn(descRef.current)
                      if (s) quote(s, null)
                    }}
                  >
                    <IconQuote size={14} />
                  </button>
                </div>
                <div className="eva-rv-body" ref={descRef}>
                  {t.description.trim() ? (
                    <Markdown text={linearDisplay(t.description, everyone)} />
                  ) : (
                    <span className="eva-rv-dim">No description.</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="eva-rv-conv" data-testid="linear-comments">
                {timeline.length === 0 ? <div className="eva-rv-dim">No comments yet.</div> : null}
                {timeline.map((e) =>
                  e.kind === 'astra' ? (
                    <AstraThreadView
                      key={`astra-${e.thread.id}`}
                      {...threadProps(e.thread)}
                      now={now}
                      look="linear"
                      me={t.me.name}
                      onReply={(root, text) =>
                        astra.ask(threadReplyText(root, text), t.key, () => ticketContext(t))
                      }
                      onUseAsReply={setDraft}
                    />
                  ) : (
                    <div key={e.item.id} className="eva-rv-lthread" data-testid="linear-thread">
                      <CommentView
                        c={e.item}
                        now={now}
                        people={everyone}
                        onReply={() =>
                          setReply((r) =>
                            r && r.to.id === e.item.id ? r : { to: e.item, text: '' },
                          )
                        }
                        onQuote={(text) => quote(text, e.item)}
                      />
                      {repliesTo(e.item.id).length > 0 || reply?.to.id === e.item.id ? (
                        <div className="eva-rv-lreplies">
                          {repliesTo(e.item.id).map((r) => (
                            <CommentView
                              key={r.id}
                              c={r}
                              now={now}
                              people={everyone}
                              onQuote={(text) => quote(text, e.item)}
                            />
                          ))}
                          {reply?.to.id === e.item.id ? (
                            <div className="eva-rv-linline" data-testid="linear-inline-reply">
                              <div className="eva-rv-dim eva-rv-small">
                                Replying to {e.item.author.name}&apos;s comment
                              </div>
                              <ReplyBox
                                value={reply.text}
                                onChange={(text) => setReply({ to: e.item, text })}
                                people={t.people}
                                placeholder={`Reply to ${e.item.author.name}. Type @Astra to ask Astra privately.`}
                                target={`sends to Linear as a reply to ${e.item.author.name}`}
                                busy={busy}
                                autoFocus
                                onSend={() => void send(reply.text, e.item)}
                                onCancel={() => setReply(null)}
                                testid="linear-reply-box"
                              />
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ),
                )}
              </div>
            )}
          </div>
          <div className="eva-rv-composer">
            <ReplyBox
              value={draft}
              onChange={setDraft}
              people={t.people}
              placeholder="Leave a comment. Type @ to mention, @Astra to ask Astra privately."
              target={`sends to ${t.key} as a new comment`}
              busy={busy}
              onSend={() => void send(draft, null)}
              testid="linear-composer"
            />
          </div>
        </div>
        <Rail t={t} />
      </div>

      <EvaModal
        opened={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.parent ? 'Post this reply on Linear?' : 'Post this comment on Linear?'}
        size={480}
      >
        <div className="eva-rv-confirm-text" data-testid="review-confirm-text">
          {confirm?.body}
        </div>
        <div className="eva-rv-dim eva-rv-small">
          {confirm?.parent
            ? `Posts as you under ${confirm.parent.author.name}'s comment on ${t.key}.`
            : `Posts as you on ${t.key}.`}{' '}
          Everyone on the ticket sees it.
        </div>
        <div className="eva-rv-modal-actions">
          <Button variant="default" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void post()} data-testid="review-confirm-post">
            {confirm?.parent ? 'Post reply' : 'Post comment'}
          </Button>
        </div>
      </EvaModal>
    </section>
  )
}
