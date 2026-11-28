import { Fragment, type ReactNode } from 'react'
import { IconPlus } from '@tabler/icons-react'
import { splitRows, type DiffLine, type Hunk } from '@relay/protocol/unified-diff'
import { highlightHunks, isTooLarge, languageForPath, type HunkHtml } from './diff-highlight'
import { rowLines } from './guide-hunks'
import '../chat/markdown/markdown.css'
import './diff-tree.css'

/** A line's text: highlight.js markup when the file has it (it escapes the source), else plain. */
function Code({ line, html }: { line: DiffLine; html: HunkHtml | null }) {
  const h = html?.get(line)
  if (h === undefined) return <>{line.text}</>
  return <code className="hljs" dangerouslySetInnerHTML={{ __html: h }} />
}

/** Starts a review thread on a line (shown on hover or focus, in the line number's gutter). */
export type DiffCommentOn = (line: DiffLine) => void

function AddComment({ line, onComment }: { line: DiffLine; onComment?: DiffCommentOn }) {
  if (!onComment) return null
  return (
    <button
      type="button"
      className="eva-rv-addline"
      aria-label={`Comment on line ${String(line.kind === 'del' ? line.old : line.new)}`}
      data-testid="review-diff-addline"
      onClick={() => onComment(line)}
    >
      <IconPlus size={12} />
    </button>
  )
}

function Cell({
  line,
  side,
  html,
  onComment,
}: {
  line: DiffLine | null
  side: 'left' | 'right'
  html: HunkHtml | null
  onComment?: DiffCommentOn
}) {
  if (!line)
    return (
      <>
        <td className="eva-rv-num" data-kind="empty" />
        <td className="eva-rv-code" data-kind="empty" />
      </>
    )
  const n = side === 'left' ? line.old : line.new
  const kind = line.kind === 'ctx' ? 'ctx' : line.kind
  return (
    <>
      <td className="eva-rv-num" data-kind={kind}>
        {n}
        {side === 'right' || line.kind === 'del' ? (
          <AddComment line={line} onComment={onComment} />
        ) : null}
      </td>
      <td className="eva-rv-code" data-kind={kind}>
        <Code line={line} html={html} />
      </td>
    </>
  )
}

function Skipped({ count, cols }: { count: number; cols: number }) {
  if (count <= 0) return null
  return (
    <tr>
      <td colSpan={cols} className="eva-rv-skip">
        {count} unchanged {count === 1 ? 'line' : 'lines'}
      </td>
    </tr>
  )
}

/** Rows a caller puts under a line (the Guide's callouts, review threads); nothing when it has none. */
export type DiffAnnotate = (lines: readonly DiffLine[]) => ReactNode

function Annotation({ node, cols }: { node: ReactNode; cols: number }) {
  if (node === null || node === undefined || node === false) return null
  return (
    <tr data-testid="review-diff-annotation">
      <td colSpan={cols} className="eva-rv-annot">
        {node}
      </td>
    </tr>
  )
}

function UnifiedRow({
  line,
  html,
  onComment,
}: {
  line: DiffLine
  html: HunkHtml | null
  onComment?: DiffCommentOn
}) {
  return (
    <tr
      data-testid="review-diff-line"
      data-old={line.old ?? undefined}
      data-new={line.new ?? undefined}
    >
      <td className="eva-rv-num" data-kind={line.kind}>
        {line.old}
      </td>
      <td className="eva-rv-num" data-kind={line.kind}>
        {line.new}
        <AddComment line={line} onComment={onComment} />
      </td>
      <td className="eva-rv-sign" data-kind={line.kind}>
        {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''}
      </td>
      <td className="eva-rv-code" data-kind={line.kind}>
        <Code line={line} html={html} />
      </td>
    </tr>
  )
}

interface Body {
  hunks: readonly Hunk[]
  html: HunkHtml | null
  annotate?: DiffAnnotate
  onComment?: DiffCommentOn
}

function SplitBody({ hunks, html, annotate, onComment }: Body) {
  return (
    <tbody>
      {hunks.map((h, hi) => (
        <Fragment key={hi}>
          <Skipped count={h.skipped} cols={4} />
          {splitRows(h.lines).map((r, i) => (
            <Fragment key={i}>
              <tr
                data-testid="review-diff-line"
                data-old={r.left?.old ?? undefined}
                data-new={r.right?.new ?? undefined}
              >
                <Cell line={r.left} side="left" html={html} onComment={onComment} />
                <Cell line={r.right} side="right" html={html} onComment={onComment} />
              </tr>
              {annotate ? <Annotation node={annotate(rowLines(r))} cols={4} /> : null}
            </Fragment>
          ))}
        </Fragment>
      ))}
    </tbody>
  )
}

function UnifiedBody({ hunks, html, annotate, onComment }: Body) {
  return (
    <tbody>
      {hunks.map((h, hi) => (
        <Fragment key={hi}>
          <Skipped count={h.skipped} cols={4} />
          {h.lines.map((l, i) => (
            <Fragment key={i}>
              <UnifiedRow line={l} html={html} onComment={onComment} />
              {annotate ? <Annotation node={annotate([l])} cols={4} /> : null}
            </Fragment>
          ))}
        </Fragment>
      ))}
    </tbody>
  )
}

/**
 * One file's hunks, side by side (old left, new right) or unified with +/- gutters. Long lines wrap
 * inside fixed gutters (no line scrolls sideways). `annotate` adds a row under a unified line, or
 * under a split row for the lines it shows; `onComment` offers a + on each line to start a thread.
 */
export function DiffView({
  hunks,
  mode,
  path,
  annotate,
  onComment,
}: {
  hunks: readonly Hunk[]
  mode: 'split' | 'unified'
  path: string
  annotate?: DiffAnnotate
  onComment?: DiffCommentOn
}) {
  const html = highlightHunks(path, hunks)
  const large = html === null && languageForPath(path) !== null && isTooLarge(hunks)
  const body: Body = { hunks, html, annotate, onComment }
  return (
    <>
      {large ? (
        <div className="eva-rv-skip" data-testid="review-diff-plain">
          Syntax highlighting off for large file
        </div>
      ) : null}
      <table className="eva-rv-diff" data-mode={mode} data-testid="review-diff">
        {mode === 'split' ? (
          <colgroup>
            <col className="eva-rv-numcol" />
            <col />
            <col className="eva-rv-numcol" />
            <col />
          </colgroup>
        ) : (
          <colgroup>
            <col className="eva-rv-numcol" />
            <col className="eva-rv-numcol" />
            <col className="eva-rv-signcol" />
            <col />
          </colgroup>
        )}
        {mode === 'split' ? <SplitBody {...body} /> : <UnifiedBody {...body} />}
      </table>
    </>
  )
}
