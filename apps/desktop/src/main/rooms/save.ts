import * as fs from 'node:fs'
import * as path from 'node:path'
import type { EvaFs } from '@evaos/eva-core'
import type { Room, RoomCard } from '@evaos/contract'
import { councilLabel, councilMoney } from '@relay/protocol'
import { authorName, slugOf } from './prompts'

const pad = (n: number): string => String(n).padStart(2, '0')
/** Local calendar date, `2026-10-26`. */
export function dateStamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const timeOf = (ts: number): string => {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A council room's latest deliverable card (a resumed room delivers again). */
function deliverableOf(room: Room): (RoomCard & { type: 'deliverable' }) | undefined {
  for (let i = room.messages.length - 1; i >= 0; i--) {
    const card = room.messages[i]!.card
    if (card?.type === 'deliverable') return card
  }
  return undefined
}

/** "7.5/10", or "not scored" when the room had no scorecard. */
const scoreText = (total: number | undefined): string =>
  total === undefined ? 'not scored' : `${total}/10`

const list = (lines: readonly string[], empty: string): string =>
  lines.length > 0 ? lines.map((x) => `- ${x}`).join('\n') : empty

/** The council part of a record: notch, spend, scores, and what the deliverable says. */
function councilSection(room: Room): string {
  const c = room.council
  if (!c) return ''
  const d = deliverableOf(room)
  const scores = c.scores.map((s) => `Round ${s.round}: ${s.total}/10`)
  const delivered = d
    ? `
### Changes

${list(d.changes, '_None recorded._')}

### Dissent

${list(d.dissent, 'None')}

### Who did what

${list(
  d.who.map(
    (w) =>
      `${authorName(room, w.agentId)}${w.part ? ` (${w.part})` : ''}: ${w.did}, ${w.turns} turns, ${councilMoney(w.usd)}, moved ${w.moved}`,
  ),
  '_Nobody took a turn._',
)}
`
    : ''
  return `
## Council

- Notch: ${councilLabel(c.effort)}, parts: ${c.parts.join(', ')}, ${c.round} of ${c.maxRounds} rounds
- Spend: ${councilMoney(c.spend.usd)} list of a ${councilMoney(c.spend.cap)} cap (estimate ${councilMoney(c.spend.estimate)})
- Workdir: ${c.workdir} (merge by hand; the source ${c.source} was not touched)
${c.routingFile ? `- Routing log: ${c.routingFile}\n` : ''}
### Scores

${list(scores, '_No scorecard._')}
${delivered}`
}

/** The markdown record of a resolved room: the summary first, then the thread, grep-friendly. */
export function roomRecord(room: Room): string {
  const summary = room.messages.find((m) => m.kind === 'summary')
  const d = deliverableOf(room)
  const people = room.agents
    .map((a) => `- ${a.name}, ${a.title} (${a.role}, ${a.model})${a.failed ? ', dropped out' : ''}`)
    .join('\n')
  const thread = room.messages
    .filter((m) => m.kind !== 'summary' && m.card?.type !== 'deliverable')
    .map((m) => {
      const re =
        m.reactions.length > 0
          ? `\n  ${m.reactions.map((r) => `${r.emoji} ${r.by.map((b) => authorName(room, b)).join(', ')}`).join(' · ')}`
          : ''
      return `- ${timeOf(m.ts)} **${authorName(room, m.author)}**: ${m.text.replace(/\n/g, '\n  ')}${re}`
    })
    .join('\n')
  const minutes = Math.round(((room.resolvedAt ?? room.startedAt) - room.startedAt) / 60_000)
  const summaryText =
    summary?.text ??
    (d
      ? `Delivered ${scoreText(d.total)}.${d.changes.length > 0 ? ` ${d.changes.join('; ')}.` : ''}`
      : '_No summary was written._')
  return `# Room: ${room.title}

- Date: ${dateStamp(room.startedAt)} ${timeOf(room.startedAt)}, ${minutes} min, ${room.rounds} round${room.rounds === 1 ? '' : 's'}
- Asked by: Isaac
- Summary by: ${summary ? authorName(room, summary.author) : d ? 'Room' : 'nobody'}
${room.judge ? `- Judge: ${room.judge.verdict}: ${room.judge.note}\n` : ''}
## Question

${room.prompt}

## Summary

${summaryText}
${councilSection(room)}
## People

${people}

## Thread

${thread}
`
}

/**
 * `memory/rooms/<date>-<slug>`, relative to the Eva root, with neither a record (`.md`) nor a
 * routing log (`.routing.jsonl`) there yet: a room's two files share it, never clobbering an
 * earlier room.
 */
export function roomStem(evaRoot: string, room: Room): string {
  const base = `memory/rooms/${dateStamp(room.startedAt)}-${slugOf(room.title)}`
  const taken = (stem: string): boolean =>
    fs.existsSync(path.join(evaRoot, `${stem}.md`)) ||
    fs.existsSync(path.join(evaRoot, `${stem}.routing.jsonl`))
  let stem = base
  for (let n = 2; taken(stem); n++) stem = `${base}-${n}`
  return stem
}

/** The journal heading and bullets a resolved room adds. */
export function journalEntry(room: Room, file: string): { heading: string; bullets: string[] } {
  const d = deliverableOf(room)
  if (room.council && d) {
    return {
      heading: `${dateStamp(room.startedAt)} [eva-interface] Council room: ${room.title}`,
      bullets: [
        `Delivered: ${scoreText(d.total)} at ${councilLabel(room.council.effort)}, ${councilMoney(d.spent)} list, workdir ${d.workdir} (merge by hand)`,
        `Record: ${file}`,
      ],
    }
  }
  const summary = room.messages.find((m) => m.kind === 'summary')?.text ?? ''
  const m = /\*\*Decision\*\*\s*\n([\s\S]*?)(?:\n\s*\n|\n\*\*|$)/.exec(summary)
  const decision = (m?.[1] ?? summary).replace(/\s+/g, ' ').trim().slice(0, 300)
  return {
    heading: `${dateStamp(room.startedAt)} [eva-interface] Room: ${room.title}`,
    bullets: [`Decision: ${decision === '' ? 'none recorded' : decision}`, `Record: ${file}`],
  }
}

export interface SaveRoomOptions {
  evaRoot: string
  /** The sanctioned writer for the Eva checkout (the write trap blocks anything else). */
  evaFs: Pick<EvaFs, 'write'>
  /**
   * Runs `journal-add.ts` with the heading and bullets; rejects when it fails. A child process
   * is outside this process's write trap, so the script writes memory/journal.md itself.
   */
  journal: (heading: string, bullets: string[]) => Promise<void>
}

/**
 * Writes the record to `<stem>.md` (a fresh stem unless the room already holds one) and the
 * journal line; returns the record's absolute path.
 */
export async function saveRoom(room: Room, o: SaveRoomOptions, stem?: string): Promise<string> {
  const rel = `${stem ?? roomStem(o.evaRoot, room)}.md`
  await o.evaFs.write('room-record', rel, roomRecord(room))
  const file = path.join(o.evaRoot, rel)
  const entry = journalEntry(room, file)
  await o.journal(entry.heading, entry.bullets)
  return file
}
