import { useState } from 'react'
import { IconCheck, IconChevronDown, IconUser } from '@tabler/icons-react'
import type { LaunchPatch, LaunchState } from '@evaos/contract'
import { EvaPopover } from '../../overlay'

type Choice = {
  id: 'current' | 'personal' | 'work'
  label: string
  profile: 'personal' | 'work' | null
}
const CHOICES: readonly Choice[] = [
  { id: 'current', label: 'Current', profile: null },
  { id: 'personal', label: 'Personal', profile: 'personal' },
  { id: 'work', label: 'Work', profile: 'work' },
]

/** Which omp account starts a new chat. Rendered only while the chat is unsent. */
export function AccountPicker({
  state,
  disabled,
  onChange,
}: {
  state: LaunchState
  disabled: boolean
  onChange: (patch: LaunchPatch) => void
}) {
  const [opened, setOpened] = useState(false)
  const current = CHOICES.find((c) => c.profile === state.profile) ?? CHOICES[0]!
  return (
    <EvaPopover opened={opened && !disabled} onChange={setOpened} position="top-start">
      <EvaPopover.Target>
        <button
          type="button"
          className="eva-toolbar-btn eva-label"
          data-testid="composer-account"
          aria-disabled={disabled}
          aria-label="omp account"
          onClick={() => {
            if (!disabled) setOpened((o) => !o)
          }}
        >
          <IconUser size={14} />
          <span>{current.label}</span>
          <IconChevronDown size={14} />
        </button>
      </EvaPopover.Target>
      <EvaPopover.Dropdown>
        <div className="eva-picker-list" role="listbox" aria-label="omp account">
          {CHOICES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={c.id === current.id}
              className="eva-picker-item eva-label"
              data-testid={`account-option-${c.id}`}
              onClick={() => {
                setOpened(false)
                if (c.id !== current.id) onChange({ profile: c.profile })
              }}
            >
              <span className="eva-picker-check">
                {c.id === current.id ? <IconCheck size={14} /> : null}
              </span>
              <span className="eva-picker-name">{c.label}</span>
            </button>
          ))}
        </div>
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}
