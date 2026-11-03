import { useMemo, useState } from 'react'
import { Button, Group, Text, UnstyledButton } from '@mantine/core'
import { IconChevronRight } from '@tabler/icons-react'
import type { DiffSpec } from '@evaos/chat-core/widget'
import { highlight } from '../../markdown/CodeBlock'
// highlight.js token colors.
import '../../markdown/markdown.css'

/** Rows shown before "Show N more" (widgets.rs DIFF_ROWS). */
export const DIFF_ROWS = 60

export type LineKind = 'context' | 'added' | 'deleted' | 'hunk'
export type Block = 'added' | 'modified' | 'deleted'

export interface DiffLine {
  kind: LineKind
  /** The line number in the new file (context and added lines). */
  number: number | null
  text: string
  /** What the run of changes this line belongs to does. */
  block: Block | null
}

/** A unified diff as rows, each change run marked added, modified (both) or deleted (diff_lines). */
export function diffLines(patch: string): { lines: DiffLine[]; file: string | null } {
  const lines: DiffLine[] = []
  let file: string | null = null
  let next = 0
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).trim()
      file = path.startsWith('b/') ? path.slice(2) : path
      continue
    }
    if (
      raw.startsWith('--- ') ||
      raw.startsWith('diff ') ||
      raw.startsWith('index ') ||
      raw.startsWith('\\')
    ) {
      continue
    }
    if (raw.startsWith('@@')) {
      const rest = raw.slice(2)
      const start = /\+(\d+)/.exec(rest)
      if (start) next = Number(start[1])
      const close = rest.indexOf('@@')
      lines.push({
        kind: 'hunk',
        number: null,
        text: close === -1 ? '' : rest.slice(close + 2).trim(),
        block: null,
      })
      continue
    }
    const sign = raw[0]
    const kind: LineKind = sign === '+' ? 'added' : sign === '-' ? 'deleted' : 'context'
    const text = sign === '+' || sign === '-' || sign === ' ' ? raw.slice(1) : raw
    lines.push({
      kind,
      number: kind === 'deleted' ? null : next++,
      text: text.replaceAll('\t', '    '),
      block: null,
    })
  }
  // A trailing newline in the patch is not a context line.
  const last = lines.at(-1)
  if (last && last.kind === 'context' && last.text === '' && patch.endsWith('\n')) lines.pop()
  // Mark each run of changes by what it does.
  let start = 0
  while (start < lines.length) {
    const changed = (l: DiffLine): boolean => l.kind === 'added' || l.kind === 'deleted'
    if (!changed(lines[start]!)) {
      start++
      continue
    }
    let end = start
    while (end < lines.length && changed(lines[end]!)) end++
    const run = lines.slice(start, end)
    const added = run.some((l) => l.kind === 'added')
    const deleted = run.some((l) => l.kind === 'deleted')
    const block: Block = added && deleted ? 'modified' : added ? 'added' : 'deleted'
    for (const line of run) line.block = block
    start = end
  }
  return { lines, file }
}

/**
 * One file's unified diff, Zed style (widgets.rs diff): a collapsible header with the name, its
 * dimmed directory and +/- counts, then new-file line numbers, a gutter bar per change block,
 * tinted rows without +/- markers, sideways scroll, and 60 rows before "Show N more".
 */
export function DiffWidget({ spec }: { spec: DiffSpec }) {
  const [open, setOpen] = useState(true)
  const [all, setAll] = useState(false)
  const { lines, file } = useMemo(() => diffLines(spec.patch), [spec.patch])
  const path = spec.file ?? file ?? 'Changes'
  const slash = path.lastIndexOf('/')
  const name = slash === -1 ? path : path.slice(slash + 1)
  const dir = slash === -1 ? null : path.slice(0, slash)
  const dot = name.lastIndexOf('.')
  const lang = dot === -1 ? '' : name.slice(dot + 1)
  const added = lines.filter((l) => l.kind === 'added').length
  const deleted = lines.filter((l) => l.kind === 'deleted').length
  const shown = all ? lines : lines.slice(0, DIFF_ROWS)
  const hidden = lines.length - shown.length
  // Highlighting every row up front keeps "Show N more" instant; patches cap at 50k chars.
  const html = useMemo(
    () => lines.map((l) => (l.kind === 'hunk' ? null : highlight(lang, l.text))),
    [lines, lang],
  )

  return (
    <div className="eva-w-diff" data-testid="widget-diff">
      <UnstyledButton
        className="eva-w-diff-head"
        data-open={open}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <IconChevronRight className="eva-w-diff-chevron" size={14} stroke={1.75} />
        <Text size="sm" fw={500} style={{ flex: 'none' }}>
          {name}
        </Text>
        {dir !== null ? (
          <Text size="xs" c="dimmed" className="eva-w-diff-dir">
            {dir}
          </Text>
        ) : null}
        <span style={{ flex: 1 }} />
        <Group gap="xs" wrap="nowrap" style={{ flex: 'none' }}>
          <Text size="xs" fw={500} c="var(--mantine-color-green-text)">
            +{added}
          </Text>
          <Text size="xs" fw={500} c="var(--mantine-color-red-text)">
            {'\u2212'}
            {deleted}
          </Text>
        </Group>
      </UnstyledButton>
      {open ? (
        <>
          <div className="eva-w-diff-rows">
            <div className="eva-w-diff-table">
              {shown.map((line, i) => (
                <div
                  key={i}
                  className="eva-w-diff-row"
                  data-kind={line.kind}
                  data-testid="diff-row"
                >
                  <span className="eva-w-diff-bar" data-block={line.block ?? undefined} />
                  <span className="eva-w-diff-num">{line.number ?? ''}</span>
                  {html[i] ? (
                    <code
                      className="eva-w-diff-code hljs"
                      // highlight.js escapes the source; only its own span markup is HTML.
                      dangerouslySetInnerHTML={{ __html: html[i]! }}
                    />
                  ) : (
                    <code className="eva-w-diff-code">
                      {line.kind === 'hunk' && line.text === '' ? '...' : line.text}
                    </code>
                  )}
                </div>
              ))}
            </div>
          </div>
          {hidden > 0 ? (
            <div className="eva-w-diff-more">
              <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setAll(true)}>
                Show {hidden} more
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
