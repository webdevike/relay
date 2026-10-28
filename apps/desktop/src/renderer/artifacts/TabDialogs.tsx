import { useEffect, useState } from 'react'
import { Button, Chip, SegmentedControl, TextInput } from '@mantine/core'
import { ARTIFACT_KINDS, type ArtifactTab, type TabRule } from '@evaos/chat-core/artifacts'
import { EvaModal } from '../overlay'
import { draftOf, KIND_LABEL, ruleOf, type RuleDraft } from './artifacts-model'

/** Renames a tab; resolves once the host took it. */
export function RenameDialog({
  tab,
  onClose,
  onSave,
}: {
  tab: ArtifactTab | null
  onClose: () => void
  onSave: (tab: ArtifactTab, title: string) => Promise<boolean>
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (tab) setName(tab.title)
  }, [tab])
  const save = async (): Promise<void> => {
    if (!tab || name.trim() === '') return
    setBusy(true)
    const ok = await onSave(tab, name.trim())
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <EvaModal
      opened={tab !== null}
      onClose={onClose}
      title="Rename tab"
      size={380}
      testid="artifacts-rename"
    >
      <form
        className="eva-art-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <TextInput
          aria-label="Tab name"
          data-autofocus
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          data-testid="artifacts-rename-input"
        />
        <div className="eva-art-dialog-actions">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={name.trim() === ''}>
            Rename
          </Button>
        </div>
      </form>
    </EvaModal>
  )
}

const TRISTATE = [
  { label: 'Any', value: 'any' },
  { label: 'Yes', value: 'yes' },
  { label: 'No', value: 'no' },
]

/** Edits a tab's rule as chips and fields; an empty rule shows everything. */
export function RuleDialog({
  tab,
  onClose,
  onSave,
}: {
  tab: ArtifactTab | null
  onClose: () => void
  onSave: (tab: ArtifactTab, rule: TabRule) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<RuleDraft>(draftOf(undefined))
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (tab) setDraft(draftOf(tab.rule))
  }, [tab])
  const set = (patch: Partial<RuleDraft>): void => setDraft((d) => ({ ...d, ...patch }))
  const save = async (): Promise<void> => {
    if (!tab) return
    setBusy(true)
    const ok = await onSave(tab, ruleOf(draft, tab.rule?.since))
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <EvaModal
      opened={tab !== null}
      onClose={onClose}
      title={tab ? `Rule for ${tab.title}` : 'Rule'}
      size={460}
      testid="artifacts-rule"
    >
      <form
        className="eva-art-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="eva-art-field">
          <span className="eva-art-field-label">Kinds</span>
          <Chip.Group
            multiple
            value={draft.kinds}
            onChange={(v) =>
              set({
                kinds: v.filter((k): k is RuleDraft['kinds'][number] =>
                  (ARTIFACT_KINDS as readonly string[]).includes(k),
                ),
              })
            }
          >
            <div className="eva-art-chips">
              {ARTIFACT_KINDS.map((k) => (
                <Chip key={k} value={k} size="xs" variant="outline">
                  {KIND_LABEL[k]}
                </Chip>
              ))}
            </div>
          </Chip.Group>
        </div>
        <TextInput
          label="States"
          description="Comma separated: open, draft, in progress, started, running"
          value={draft.states}
          onChange={(e) => set({ states: e.currentTarget.value })}
          data-testid="artifacts-rule-states"
        />
        <TextInput
          label="Caption or title has"
          description="Use | for either: before|after"
          maxLength={120}
          value={draft.caption}
          onChange={(e) => set({ caption: e.currentTarget.value })}
        />
        <TextInput
          label="Repo"
          description="owner/name or just name"
          maxLength={200}
          value={draft.repo}
          onChange={(e) => set({ repo: e.currentTarget.value })}
        />
        <div className="eva-art-field-row">
          <div className="eva-art-field">
            <span className="eva-art-field-label">Image or video</span>
            <SegmentedControl
              size="xs"
              data={TRISTATE}
              value={draft.media}
              onChange={(v) => set({ media: v as RuleDraft['media'] })}
            />
          </div>
          <div className="eva-art-field">
            <span className="eva-art-field-label">Pinned</span>
            <SegmentedControl
              size="xs"
              data={TRISTATE}
              value={draft.pinned}
              onChange={(v) => set({ pinned: v as RuleDraft['pinned'] })}
            />
          </div>
        </div>
        <div className="eva-art-dialog-actions">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} data-testid="artifacts-rule-save">
            Save rule
          </Button>
        </div>
      </form>
    </EvaModal>
  )
}
