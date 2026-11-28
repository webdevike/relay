// What the host's write gate approved, shown whole in a confirm (PLAN §2.5): its one-line summary
// (live keys and titles, the account it writes as), the description text an inline comment quotes,
// and every row a plan writes. The exact text written is the confirm's own body (`approval.text`).
import type { TicketConfirm } from '@relay/protocol'
import './tickets.css'

export function ApprovalNote({ approval }: { approval: TicketConfirm }) {
  return (
    <div className="eva-tk-approval" data-testid="approval-note">
      <div data-testid="approval-summary">{approval.summary}</div>
      {approval.quote ? (
        <blockquote className="eva-tk-approval-quote" data-testid="approval-quote">
          {approval.quote}
        </blockquote>
      ) : null}
      {approval.rows && approval.rows.length > 0 ? (
        <ul className="eva-tk-approval-rows" data-testid="approval-rows">
          {approval.rows.map((r) => (
            <li key={r.key} data-testid="approval-row">
              <span className="eva-rv-mono">{r.key}</span> {r.title}: {r.change}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
