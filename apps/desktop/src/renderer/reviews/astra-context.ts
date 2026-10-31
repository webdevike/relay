import type { LinearTicket, ReviewPr, SlackRow, SlackThread } from '@evaos/contract'

/** The diff Astra gets in her first message; she can always read the rest with gh. */
const MAX_DIFF = 150_000

const when = (at: number): string =>
  at ? new Date(at).toISOString().slice(0, 16).replace('T', ' ') : ''

/** A PR as the first message of its Astra session: what a reviewer sees, as Markdown. */
export function prContext(pr: ReviewPr): string {
  const diff =
    pr.diff.length > MAX_DIFF
      ? `${pr.diff.slice(0, MAX_DIFF)}\n[... diff cut; run gh pr diff ${pr.number} -R ${pr.repo} for the rest]`
      : pr.diff
  return [
    `### Pull request ${pr.repo}#${pr.number}: ${pr.title}`,
    `${pr.url}`,
    `${pr.draft ? 'Draft' : pr.state} · by ${pr.author.login} · ${pr.base} <- ${pr.head} · +${pr.additions} -${pr.deletions}`,
    `Reviewers: ${pr.reviewers.map((r) => `${r.login} (${r.state.toLowerCase()})`).join(', ') || 'none'}`,
    `Checks: ${pr.checks.map((c) => `${c.name} ${c.state}`).join(', ') || 'none'}`,
    '',
    '#### Description',
    pr.body.trim() || '(none)',
    '',
    '#### Conversation',
    pr.timeline.length === 0
      ? '(no comments)'
      : pr.timeline
          .map(
            (t) =>
              `- ${t.author}${t.state ? ` (${t.state.toLowerCase()})` : ''}, ${when(t.at)}: ${t.body.trim()}`,
          )
          .join('\n'),
    '',
    '#### Files',
    pr.files.map((f) => `- ${f.path} (+${f.additions} -${f.deletions})`).join('\n'),
    '',
    '#### Diff',
    '```diff',
    diff,
    '```',
  ].join('\n')
}

/** A Linear ticket as the first message of its Astra session. */
export function ticketContext(t: LinearTicket): string {
  const byId = new Map(t.comments.map((c) => [c.id, c]))
  return [
    `### Linear ticket ${t.key}: ${t.title}`,
    t.url,
    `${t.state.name} · ${t.priority} · assignee ${t.assignee ?? 'none'} · project ${t.project ?? 'none'} · team ${t.team}`,
    t.parent ? `Parent: ${t.parent.key} ${t.parent.title}` : '',
    t.children.length
      ? `Sub-issues: ${t.children.map((c) => `${c.key} ${c.title} (${c.state})`).join('; ')}`
      : '',
    t.links.length ? `Links: ${t.links.map((l) => `${l.title} ${l.url}`).join('; ')}` : '',
    '',
    '#### Description',
    t.description.trim() || '(none)',
    '',
    '#### Comments (oldest first; replies name the comment they answer)',
    t.comments.length === 0
      ? '(no comments)'
      : t.comments
          .map((c) => {
            const parent = c.parentId ? byId.get(c.parentId) : undefined
            const reply = parent ? ` replying to ${parent.author.name}` : ''
            return `- ${c.author.name}${reply}, ${when(c.at)}: ${c.body.trim()}`
          })
          .join('\n'),
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n')
}

/** A Slack thread or DM as the first message of its Astra session: the messages last read. */
export function slackContext(row: SlackRow, thread: SlackThread | null): string {
  const where = row.threadTs ? `thread in ${row.channelName}` : `DM with ${row.channelName}`
  const messages = thread?.messages ?? []
  return [
    `### Slack ${where}`,
    row.url,
    `channel=${row.channel} thread_ts=${row.threadTs ?? 'none'}`,
    `Waiting on Isaac: ${row.author} ${row.kind === 'mention' ? 'mentioned him' : row.kind === 'dm' ? 'wrote to him' : 'replied'}`,
    '',
    '#### Messages (oldest first)',
    messages.length === 0
      ? `(not read yet; newest: ${row.author}: ${row.text})`
      : messages
          .map((m) => `- ${m.mine ? 'Isaac (me)' : m.author}, ${when(m.at)}: ${m.text.trim()}`)
          .join('\n'),
    '',
    'To reply in Slack, write the exact text: Reviews hands it to your main thread as a "Slack send request" after Isaac confirms it.',
  ].join('\n')
}
