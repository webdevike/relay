import { Fragment, type ReactNode } from 'react'
import { splitRows, type DiffLine, type Hunk } from '@relay/protocol/unified-diff'
import { highlightHunks, isTooLarge, languageForPath, type HunkHtml } from './diff-highlight'
import { rowLines } from './guide-hunks'
import '../chat/markdown/markdown.css'

/** A line's text: highlight.js markup when the file has it (it escapes the source), else plain. */
function Code({ line, html }: { line: DiffLine; html: HunkHtml | null }) {
  const h = html?.get(line)
  if (h === undefined) return <>{line.text}</>
  return <code className="hljs" dangerouslySetInnerHTML={{ __html: h }} />
}

function Cell({
  line,
  side,
  html,
}: {
  line: DiffLine | null
  side: 'left' | 'right'
  html: HunkHtml | null
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

/** Rows a caller puts under a line (the Guide's callouts); nothing when it has none. */
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

/**
 * One file's hunks, side by side (old left, new right) or unified with +/- gutters. `annotate`
 * adds a row under a unified line, or under a split row for the lines it shows.
 */
export function DiffView({
  hunks,
  mode,
  path,
  annotate,
}: {
  hunks: readonly Hunk[]
  mode: 'split' | 'unified'
  path: string
  annotate?: DiffAnnotate
}) {
  const html = highlightHunks(path, hunks)
  const large = html === null && languageForPath(path) !== null && isTooLarge(hunks)
  const note = large ? (
    <div className="eva-rv-skip" data-testid="review-diff-plain">
      Syntax highlighting off for large file
    </div>
  ) : null
  if (mode === 'split') {
    return (
      <>
        {note}
        <table className="eva-rv-diff" data-mode="split" data-testid="review-diff">
          <colgroup>
            <col className="eva-rv-numcol" />
            <col />
            <col className="eva-rv-numcol" />
            <col />
          </colgroup>
          <tbody>
            {hunks.map((h, hi) => (
              <Fragment key={hi}>
                <Skipped count={h.skipped} cols={4} />
                {splitRows(h.lines).map((r, i) => (
                  <Fragment key={i}>
                    <tr>
                      <Cell line={r.left} side="left" html={html} />
                      <Cell line={r.right} side="right" html={html} />
                    </tr>
                    {annotate ? <Annotation node={annotate(rowLines(r))} cols={4} /> : null}
                  </Fragment>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </>
    )
  }
  return (
    <>
      {note}
      <table className="eva-rv-diff" data-mode="unified" data-testid="review-diff">
        <colgroup>
          <col className="eva-rv-numcol" />
          <col className="eva-rv-numcol" />
          <col className="eva-rv-signcol" />
          <col />
        </colgroup>
        <tbody>
          {hunks.map((h, hi) => (
            <Fragment key={hi}>
              <Skipped count={h.skipped} cols={4} />
              {h.lines.map((l, i) => (
                <Fragment key={i}>
                  <tr>
                    <td className="eva-rv-num" data-kind={l.kind}>
                      {l.old}
                    </td>
                    <td className="eva-rv-num" data-kind={l.kind}>
                      {l.new}
                    </td>
                    <td className="eva-rv-sign" data-kind={l.kind}>
                      {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ''}
                    </td>
                    <td className="eva-rv-code" data-kind={l.kind}>
                      <Code line={l} html={html} />
                    </td>
                  </tr>
                  {annotate ? <Annotation node={annotate([l])} cols={4} /> : null}
                </Fragment>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </>
  )
}
