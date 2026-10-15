import { useState } from 'react'
import { IconCheck, IconChevronDown } from '@tabler/icons-react'
import type { LaunchPatch, LaunchState } from '@evaos/contract'
import type { ModelInfo } from '@evaos/chat-core/launch'
import { EvaPopover } from '../../overlay'

const slug = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, '-')

/** The label for the current model: the catalog name, else the id, else a neutral default. */
export function modelLabel(state: LaunchState | null, models: readonly ModelInfo[]): string {
  const m = state?.model
  if (!m) return 'Default model'
  return models.find((x) => x.provider === m[0] && x.id === m[1])?.name ?? m[1]
}

export function ModelPicker({
  state,
  models,
  disabled,
  onChange,
}: {
  state: LaunchState | null
  models: readonly ModelInfo[]
  disabled: boolean
  onChange: (patch: LaunchPatch) => void
}) {
  const [opened, setOpened] = useState(false)
  const current = state?.model ?? null
  const info = current
    ? models.find((x) => x.provider === current[0] && x.id === current[1])
    : undefined
  const levels = info?.levels ?? []
  return (
    <EvaPopover opened={opened && !disabled} onChange={setOpened} position="top-start">
      <EvaPopover.Target>
        <button
          type="button"
          className="eva-toolbar-btn eva-label"
          data-testid="composer-model"
          aria-disabled={disabled}
          aria-label="Model"
          onClick={() => {
            if (!disabled) setOpened((o) => !o)
          }}
        >
          <span className="eva-toolbar-model">{modelLabel(state, models)}</span>
          <IconChevronDown size={14} />
        </button>
      </EvaPopover.Target>
      <EvaPopover.Dropdown>
        <div className="eva-picker-list" role="listbox" aria-label="Models">
          {models.length === 0 ? <div className="eva-label eva-dim">No models found</div> : null}
          {models.map((m) => {
            const active = current !== null && current[0] === m.provider && current[1] === m.id
            return (
              <button
                key={`${m.provider}/${m.id}`}
                type="button"
                role="option"
                aria-selected={active}
                className="eva-picker-item eva-label"
                data-testid={`model-option-${slug(m.provider)}-${slug(m.id)}`}
                onClick={() => {
                  setOpened(false)
                  if (!active) onChange({ model: { provider: m.provider, modelId: m.id } })
                }}
              >
                <span className="eva-picker-check">{active ? <IconCheck size={14} /> : null}</span>
                <span className="eva-picker-name">{m.name}</span>
              </button>
            )
          })}
          {levels.length > 0 ? (
            <div className="eva-picker-levels" role="group" aria-label="Thinking level">
              {levels.map((level) => (
                <button
                  key={level}
                  type="button"
                  className="eva-picker-level eva-label"
                  data-testid={`thinking-option-${level}`}
                  data-active={state?.thinking === level ? 'true' : undefined}
                  onClick={() => {
                    setOpened(false)
                    if (state?.thinking !== level) onChange({ thinking: level })
                  }}
                >
                  {level}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}
