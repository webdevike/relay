import type { LaunchPatch, LaunchState } from '@evaos/contract'
import type { ModelInfo } from '@evaos/chat-core/launch'
import { Picker } from './Picker'

const slug = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, '-')
const MODEL = 'model:'
const LEVEL = 'thinking:'

/** The label for the current model: the catalog name, else the id, else a neutral default. */
export function modelLabel(state: LaunchState | null, models: readonly ModelInfo[]): string {
  const m = state?.model
  if (!m) return 'Default model'
  return models.find((x) => x.provider === m[0] && x.id === m[1])?.name ?? m[1]
}

/** Models, then the current model's thinking levels, each with its own check. */
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
  const current = state?.model ?? null
  const info = current
    ? models.find((x) => x.provider === current[0] && x.id === current[1])
    : undefined
  const levels = info?.levels ?? []
  const key = (m: ModelInfo): string => JSON.stringify([m.provider, m.id])
  return (
    <Picker
      label="Model"
      testid="composer-model"
      disabled={disabled}
      empty="No models found"
      groups={[
        {
          label: levels.length > 0 ? 'Model' : undefined,
          options: models.map((m) => ({
            value: MODEL + key(m),
            label: m.name,
            active: current !== null && current[0] === m.provider && current[1] === m.id,
            testid: `model-option-${slug(m.provider)}-${slug(m.id)}`,
          })),
        },
        ...(levels.length > 0
          ? [
              {
                label: 'Thinking',
                options: levels.map((level) => ({
                  value: LEVEL + level,
                  label: level,
                  active: state?.thinking === level,
                  testid: `thinking-option-${level}`,
                })),
              },
            ]
          : []),
      ]}
      onPick={(value) => {
        if (value.startsWith(LEVEL)) {
          const level = value.slice(LEVEL.length)
          if (state?.thinking !== level) onChange({ thinking: level })
          return
        }
        const [provider, modelId] = JSON.parse(value.slice(MODEL.length)) as [string, string]
        if (current?.[0] !== provider || current?.[1] !== modelId)
          onChange({ model: { provider, modelId } })
      }}
    >
      {modelLabel(state, models)}
    </Picker>
  )
}
