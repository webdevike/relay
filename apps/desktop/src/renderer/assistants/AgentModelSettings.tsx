import { useState } from 'react'
import { Select } from '@mantine/core'
import { OMP_THINKING_LEVELS, fitThinking, levelsFor, type OmpThinking } from '@evaos/contract'
import { invoke } from '../ipc'
import { thinkingLabel } from '../chat/composer/ModelPicker'
import { familiesOf, specOf, useModelCatalog } from '../rooms/model-catalog'
import { agentOf, useAssistants } from './assistants-store'
import './assistants.css'

const isLevel = (v: string): v is OmpThinking =>
  (OMP_THINKING_LEVELS as readonly string[]).includes(v)

/** `provider/id[:level]` as its model and level; a colon that belongs to the id (`x:free`) stays in the model. */
export function splitModel(model: string): { spec: string; level: OmpThinking | null } {
  const colon = model.lastIndexOf(':')
  const level = colon < 0 ? '' : model.slice(colon + 1)
  return isLevel(level) ? { spec: model.slice(0, colon), level } : { spec: model, level: null }
}

/**
 * The model and thinking level an assistant starts on, in its avatar menu. Both write the host's
 * registry (`assistants.configure`) and apply when its session next starts; the registry watch
 * brings the new value back through the assistants store.
 */
export function AgentModelSettings({ id }: { id: string }) {
  const registry = useAssistants((s) => agentOf(s, id)?.model ?? null)
  const { models } = useModelCatalog()
  const [error, setError] = useState<string | null>(null)
  const { spec, level } = registry === null ? { spec: null, level: null } : splitModel(registry)
  const current = models?.find((m) => specOf(m) === spec)
  const levels = levelsFor(current)
  const shown = level === null ? null : fitThinking(level, levels)

  const write = (model: string): void => {
    setError(null)
    void invoke('assistants.configure', { agent: id, model }).then((r) => {
      if (!r.ok) setError(r.error.message)
    })
  }
  const chooseModel = (next: string | null): void => {
    const picked = models?.find((m) => specOf(m) === next)
    if (!picked || next === spec) return
    const fit = fitThinking(shown ?? 'medium', levelsFor(picked))
    write(`${next}:${fit}`)
  }
  const chooseLevel = (next: string | null): void => {
    if (spec === null || next === null || !isLevel(next) || next === shown) return
    write(`${spec}:${next}`)
  }

  return (
    <div
      className="eva-as-model"
      data-testid="agent-model-settings"
      // The menu around it moves focus on arrow keys; the selects keep theirs.
      onKeyDown={(e) => {
        e.stopPropagation()
      }}
    >
      <Select
        size="xs"
        label="Model"
        searchable
        allowDeselect={false}
        value={spec}
        placeholder={models === null ? 'Loading' : 'Not set'}
        disabled={models === null}
        comboboxProps={{ withinPortal: false }}
        data={familiesOf(models ?? []).map((g) => ({
          group: g.family,
          items: g.models.map((m) => ({ value: specOf(m), label: m.name })),
        }))}
        onChange={chooseModel}
        data-testid="agent-model-select"
      />
      <Select
        size="xs"
        label="Thinking"
        allowDeselect={false}
        value={shown}
        placeholder="Not set"
        disabled={current === undefined || levels.length < 2}
        comboboxProps={{ withinPortal: false }}
        data={levels.map((l) => ({ value: l, label: thinkingLabel(l) }))}
        onChange={chooseLevel}
        data-testid="agent-thinking-select"
      />
      <p className="eva-as-model-note" role={error === null ? undefined : 'alert'}>
        {error ?? 'Applies the next time it starts.'}
      </p>
    </div>
  )
}
