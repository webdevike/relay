import { Switch } from '@mantine/core'
import { setSetting, useSettings, type SettingKey } from './settings-store'

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
        className="eva-switch"
        size="md"
        data-testid={testid}
        aria-label={title}
        checked={checked}
        onChange={(e) => void setSetting(id, e.currentTarget.checked)}
      />
    </label>
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
    </div>
  )
}
