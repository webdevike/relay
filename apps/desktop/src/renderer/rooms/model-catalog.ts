import { useEffect } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ModelInfo } from '@evaos/chat-core/launch'
import { invoke } from '../ipc'

/** omp's model catalog (chat.models), read once per window: what room members may run on. */
export const catalogStore = createStore<{ models: ModelInfo[] | null; error: string | null }>(
  () => ({ models: null, error: null }),
)

let loading: Promise<void> | null = null

function load(): Promise<void> {
  loading ??= invoke('chat.models', {}).then((r) => {
    if (r.ok) catalogStore.setState({ models: r.value.models, error: null })
    else {
      catalogStore.setState({ error: r.error.message })
      loading = null
    }
  })
  return loading
}

/** The catalog, newest first; null while it loads (or when omp could not list it). */
export function useModelCatalog(): { models: ModelInfo[] | null; error: string | null } {
  useEffect(() => {
    void load()
  }, [])
  const models = useStore(catalogStore, (s) => s.models)
  const error = useStore(catalogStore, (s) => s.error)
  return { models, error }
}

export const specOf = (m: Pick<ModelInfo, 'provider' | 'id'>): string => `${m.provider}/${m.id}`

const PROVIDER: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI' }

/**
 * The family a model is listed under in the picker: `Claude Opus` for Claude Opus 5.5 and Claude
 * 4.1 Opus, `OpenAI GPT-6` for GPT-6-Sol, else the provider.
 */
export function familyOf(m: Pick<ModelInfo, 'provider' | 'name'>): string {
  const gpt = /^(GPT-\d+(?:\.\d+)?)/i.exec(m.name)
  if (gpt) return `OpenAI ${gpt[1]!.toUpperCase()}`
  if (/^claude\b/i.test(m.name)) {
    const words = m.name.split(/\s+/).filter((w) => !/^v?\d/.test(w))
    return words.slice(0, 2).join(' ')
  }
  return PROVIDER[m.provider] ?? m.provider
}

/** The catalog grouped by family, families and models in catalog order. */
export function familiesOf(
  models: readonly ModelInfo[],
): { family: string; models: ModelInfo[] }[] {
  const out: { family: string; models: ModelInfo[] }[] = []
  for (const m of models) {
    const f = familyOf(m)
    const group = out.find((g) => g.family === f)
    if (group) group.models.push(m)
    else out.push({ family: f, models: [m] })
  }
  return out
}
