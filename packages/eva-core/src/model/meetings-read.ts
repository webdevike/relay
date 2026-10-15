import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import { isInside } from '../fs/allowlist'
import { parseMeeting, sortMeetings, type Meeting } from './meetings'

// Read-only. Writes go through EvaFs.

const STEM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function meetingsDir(root: string): string {
  return join(root, 'work', 'meetings')
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Every readable record, newest first. Dotfiles, non-.json files, stems failing STEM_RE and invalid JSON are skipped. */
export function readMeetings(root: string): Meeting[] {
  const dir = meetingsDir(root)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: Meeting[] = []
  for (const name of names) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue
    // Stems the contract (and STEM_RE) cannot address are not listed.
    if (!STEM_RE.test(name.slice(0, -'.json'.length))) continue
    const path = join(dir, name)
    if (!isFile(path)) continue
    try {
      const m = parseMeeting(name.slice(0, -'.json'.length), readFileSync(path, 'utf8'))
      if (m) out.push(m)
    } catch {
      // unreadable: skip
    }
  }
  return sortMeetings(out)
}

/** One record and its raw text, or null for a bad stem, a missing file or invalid JSON. */
export function readMeetingFile(
  root: string,
  stem: string,
): { meeting: Meeting; text: string } | null {
  if (!STEM_RE.test(stem)) return null
  const path = join(meetingsDir(root), `${stem}.json`)
  try {
    if (!isFile(path)) return null
    const text = readFileSync(path, 'utf8')
    const meeting = parseMeeting(stem, text)
    return meeting ? { meeting, text } : null
  } catch {
    return null
  }
}

/**
 * The single notes resolver: absolute .md, realpath inside one of the roots, a regular file.
 * Returns the real path, or null for anything else.
 */
export function resolveNotesPath(path: string, roots: string[]): string | null {
  if (!isAbsolute(path) || extname(path).toLowerCase() !== '.md') return null
  try {
    const real = realpathSync(path)
    if (extname(real).toLowerCase() !== '.md' || !statSync(real).isFile()) return null
    const ok = roots.some((r) => {
      try {
        return isInside(real, realpathSync(r))
      } catch {
        return false
      }
    })
    return ok ? real : null
  } catch {
    return null
  }
}

/** Notes text for an absolute .md regular file inside the roots; anything else is null. */
export function readNotes(path: string, roots: string[]): string | null {
  const real = resolveNotesPath(path, roots)
  if (real === null) return null
  try {
    return readFileSync(real, 'utf8')
  } catch {
    return null
  }
}
