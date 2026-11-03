import { Fragment } from 'react'
import { splitRows, type DiffLine, type Hunk } from './diff'
import { highlightHunks, isTooLarge, languageForPath, type HunkHtml } from './diff-highlight'
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

/** One file's hunks, side by side (old left, new right) or unified with +/- gutters. */
export function DiffView({
  hunks,
  mode,
  path,
}: {
  hunks: readonly Hunk[]
  mode: 'split' | 'unified'
  path: string
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
                  <tr key={i}>
                    <Cell line={r.left} side="left" html={html} />
                    <Cell line={r.right} side="right" html={html} />
                  </tr>
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
                <tr key={i}>
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
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </>
  )
}
