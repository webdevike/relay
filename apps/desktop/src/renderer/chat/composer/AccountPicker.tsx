import { IconUser } from '@tabler/icons-react'
import type { LaunchPatch, LaunchState } from '@evaos/contract'
import { Picker } from './Picker'

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
  const current = CHOICES.find((c) => c.profile === state.profile) ?? CHOICES[0]!
  return (
    <Picker
      label="omp account"
      testid="composer-account"
      disabled={disabled}
      icon={<IconUser size={14} />}
      groups={[
        {
          options: CHOICES.map((c) => ({
            value: c.id,
            label: c.label,
            active: c.id === current.id,
            testid: `account-option-${c.id}`,
          })),
        },
      ]}
      onPick={(id) => {
        const picked = CHOICES.find((c) => c.id === id)
        if (picked && picked.id !== current.id) onChange({ profile: picked.profile })
      }}
    >
      {current.label}
    </Picker>
  )
}
