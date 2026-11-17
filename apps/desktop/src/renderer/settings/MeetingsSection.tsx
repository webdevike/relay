import { NumberInput } from '@mantine/core'
import { setSnapshotChange, useSettings } from './settings-store'

export function MeetingsSection() {
  const change = useSettings((s) => s.meeting_snapshot_change)
  return (
    <div className="eva-settings-card">
      <div className="eva-settings-row">
        <span className="eva-settings-label">
          <span className="eva-settings-label-title">Screen snapshot change</span>
          <span className="eva-settings-label-help">
            Save a new screen-share snapshot when this much of the shared screen changed.
          </span>
        </span>
        <NumberInput
          data-testid="settings-snapshot-change"
          aria-label="Screen snapshot change"
          w={96}
          min={1}
          max={50}
          step={1}
          allowDecimal={false}
          allowNegative={false}
          clampBehavior="strict"
          suffix="%"
          value={change}
          // An empty field while typing is a string; only whole numbers are saved.
          onChange={(v) => {
            if (typeof v === 'number') void setSnapshotChange(v)
          }}
        />
      </div>
    </div>
  )
}
