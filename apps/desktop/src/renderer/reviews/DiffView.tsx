import { Fragment } from 'react'
import { splitRows, type DiffLine, type Hunk } from './diff'

function Cell({ line, side }: { line: DiffLine | null; side: 'left' | 'right' }) {
  if (!line) return <><td className="eva-rv-num" data-kind="empty" /><td className="eva-rv-code" data-kind="empty" /></>
  const n = side === 'left' ? line.old : line.new
  const kind = line.kind === 'ctx' ? 'ctx' : line.kind
  return (
    <>
      <td className="eva-rv-num" data-kind={kind}>{n}</td>
      <td className="eva-rv-code" data-kind={kind}>{line.text}</td>
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
export function DiffView({ hunks, mode }: { hunks: readonly Hunk[]; mode: 'split' | 'unified' }) {
  if (mode === 'split') {
    return (
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
                  <Cell line={r.left} side="left" />
                  <Cell line={r.right} side="right" />
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    )
  }
  return (
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
                <td className="eva-rv-num" data-kind={l.kind}>{l.old}</td>
                <td className="eva-rv-num" data-kind={l.kind}>{l.new}</td>
                <td className="eva-rv-sign" data-kind={l.kind}>
                  {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ''}
                </td>
                <td className="eva-rv-code" data-kind={l.kind}>{l.text}</td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}
