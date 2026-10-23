import type { LaunchPatch, LaunchState } from '@evaos/contract'
import { APPROVAL_LABEL, type Approval } from '@evaos/chat-core/launch'
import { Picker } from './Picker'

const ORDER: readonly Approval[] = ['yolo', 'write', 'always-ask']

export function AccessPicker({
  state,
  disabled,
  onChange,
}: {
  state: LaunchState | null
  disabled: boolean
  onChange: (patch: LaunchPatch) => void
}) {
  const current = state?.approval ?? null
  return (
    <Picker
      label="Access mode"
      testid="composer-access"
      disabled={disabled}
      groups={[
        {
          options: ORDER.map((a) => ({
            value: a,
            label: APPROVAL_LABEL[a],
            active: current === a,
            testid: `access-option-${a}`,
          })),
        },
      ]}
      onPick={(a) => {
        if (current !== a) onChange({ approval: a as Approval })
      }}
    >
      {current ? APPROVAL_LABEL[current] : 'Access'}
    </Picker>
  )
}
