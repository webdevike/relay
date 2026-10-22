import { useEffect, useState } from 'react'
import { SegmentedControl, Switch } from '@mantine/core'
import { invoke } from '../ipc'
import {
  setHarness,
  setSetting,
  useSettings,
  type Harness,
  type SettingKey,
} from './settings-store'

interface RowProps {
  id: SettingKey
  testid: string
  title: string
  help: string
}

function SwitchRow({ id, testid, title, help }: RowProps) {
  const checked = useSettings((s) => s[id])
  return (
    <label className="eva-settings-row">
      <span className="eva-settings-label">
        <span className="eva-settings-label-title">{title}</span>
        <span className="eva-settings-label-help">{help}</span>
      </span>
      <Switch
        size="md"
        data-testid={testid}
        aria-label={title}
        checked={checked}
        onChange={(e) => void setSetting(id, e.currentTarget.checked)}
      />
    </label>
  )
}

const HARNESS_MISSING = 'Claude Code was not found. Install it, then try again.'

function HarnessRow() {
  const harness = useSettings((s) => s.harness)
  const [claudeFound, setClaudeFound] = useState(true)
  useEffect(() => {
    let live = true
    void invoke('chat.harnessStatus', {})
      .then((r) => {
        if (live && r.ok) setClaudeFound(r.value.claude)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  return (
    <div className="eva-settings-row">
      <span className="eva-settings-label">
        <span className="eva-settings-label-title">Harness</span>
        <span className="eva-settings-label-help">Applies to new chats.</span>
        {harness === 'claude' && !claudeFound ? (
          <span
            className="eva-settings-label-help"
            role="alert"
            data-testid="harness-missing"
            style={{ color: 'var(--mantine-color-red-6)' }}
          >
            {HARNESS_MISSING}
          </span>
        ) : null}
      </span>
      <SegmentedControl
        data-testid="settings-harness"
        aria-label="Harness"
        value={harness}
        onChange={(v) => void setHarness(v as Harness)}
        data={[
          { value: 'omp', label: 'omp' },
          { value: 'claude', label: 'Claude Code' },
        ]}
      />
    </div>
  )
}

export function ChatSection() {
  return (
    <div className="eva-settings-card">
      <SwitchRow
        id="show_thinking"
        testid="settings-show-thinking"
        title="Show thinking"
        help="The model's reasoning before each reply, in gray."
      />
      <SwitchRow
        id="show_tools"
        testid="settings-show-tools"
        title="Show tool details"
        help="Each tool call's input and output as code, like omp in a terminal. Off, a run of tools folds to one line."
      />
      <HarnessRow />
    </div>
  )
}
