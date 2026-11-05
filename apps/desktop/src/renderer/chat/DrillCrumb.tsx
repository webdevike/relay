import { Tooltip } from '@mantine/core'
import { IconChevronLeft } from '@tabler/icons-react'
import '../assistants/assistants.css'
import { elapsedLabel } from '../context/format'
import { drillStore, type DrillEntry } from './drill-store'

/** What the current transcript's title says on hover: its model and how long it has run. */
function detail(entry: DrillEntry): string {
  const age =
    entry.startedAt === undefined ? '' : `running ${elapsedLabel(entry.startedAt, Date.now())}`
  return [entry.model ?? '', age].filter((s) => s !== '').join(' \u00b7 ')
}

/**
 * The header of a pane swapped in place to a session transcript: "< Nova / Session title". The
 * arrow steps back one level, the root name returns to the thread the pane came from, and each
 * earlier title returns to that level (a transcript opened from inside another keeps its trail).
 */
export function DrillCrumb({
  paneId,
  root,
  trail,
}: {
  paneId: string
  root: string
  trail: readonly DrillEntry[]
}) {
  const last = trail.length - 1
  const tip = trail[last] ? detail(trail[last]) : ''
  return (
    <span className="eva-as-crumb" data-testid="drill-crumb">
      <button
        type="button"
        className="eva-as-crumb-back"
        aria-label="Back"
        data-testid="drill-back"
        onClick={() => drillStore.popTo(paneId, last)}
      >
        <IconChevronLeft stroke={2} aria-hidden />
      </button>
      <button
        type="button"
        className="eva-as-crumb-here eva-as-crumb-link"
        data-testid="drill-root"
        onClick={() => drillStore.popTo(paneId, 0)}
      >
        {root}
      </button>
      {trail.map((entry, i) => (
        <span key={entry.file} className="eva-as-crumb">
          <span className="eva-as-crumb-sep" aria-hidden>
            /
          </span>
          {i < last ? (
            <button
              type="button"
              className="eva-as-crumb-here eva-as-crumb-link"
              data-testid={`drill-level-${i}`}
              onClick={() => drillStore.popTo(paneId, i + 1)}
            >
              {entry.title}
            </button>
          ) : (
            <Tooltip label={tip} disabled={tip === ''} openDelay={300}>
              <span className="eva-as-crumb-here" data-testid="drill-title">
                {entry.title}
              </span>
            </Tooltip>
          )}
        </span>
      ))}
    </span>
  )
}
