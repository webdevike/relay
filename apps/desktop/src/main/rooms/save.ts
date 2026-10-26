import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Room } from '@evaos/contract'
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

/** The markdown record of a resolved room: the summary first, then the thread, grep-friendly. */
export function roomRecord(room: Room): string {
  const summary = room.messages.find((m) => m.kind === 'summary')
  const people = room.agents
    .map((a) => `- ${a.name}, ${a.title} (${a.role}, ${a.model})${a.failed ? ', dropped out' : ''}`)
    .join('\n')
  const thread = room.messages
    .filter((m) => m.kind !== 'summary')
    .map((m) => {
      const re =
        m.reactions.length > 0
          ? `\n  ${m.reactions.map((r) => `${r.emoji} ${r.by.map((b) => authorName(room, b)).join(', ')}`).join(' · ')}`
          : ''
      return `- ${timeOf(m.ts)} **${authorName(room, m.author)}**: ${m.text.replace(/\n/g, '\n  ')}${re}`
    })
    .join('\n')
  const minutes = Math.round(((room.resolvedAt ?? room.startedAt) - room.startedAt) / 60_000)
  return `# Room: ${room.title}

- Date: ${dateStamp(room.startedAt)} ${timeOf(room.startedAt)}, ${minutes} min, ${room.rounds} rounds
- Asked by: Isaac
- Summary by: ${summary ? authorName(room, summary.author) : 'nobody'}
${room.judge ? `- Judge: ${room.judge.verdict}: ${room.judge.note}\n` : ''}
## Question

${room.prompt}

## Summary

${summary?.text ?? '_No summary was written._'}

## People

${people}

## Thread

${thread}
`
}

/** `<evaRoot>/memory/rooms/<date>-<slug>.md`, never clobbering an earlier room of the same name. */
export function roomRecordPath(evaRoot: string, room: Room): string {
  const dir = path.join(evaRoot, 'memory', 'rooms')
  const base = `${dateStamp(room.startedAt)}-${slugOf(room.title)}`
  let file = path.join(dir, `${base}.md`)
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base}-${n}.md`)
  return file
}

/** The journal heading and bullets a resolved room adds. */
export function journalEntry(room: Room, file: string): { heading: string; bullets: string[] } {
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
  /** Runs `journal-add.ts` with the heading and bullets; rejects when it fails. */
  journal: (heading: string, bullets: string[]) => Promise<void>
}

/** Writes the record and the journal line; returns the record's path. */
export async function saveRoom(room: Room, o: SaveRoomOptions): Promise<string> {
  const file = roomRecordPath(o.evaRoot, room)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, roomRecord(room))
  const entry = journalEntry(room, file)
  await o.journal(entry.heading, entry.bullets)
  return file
}
