import { useState } from 'react'
import { IconCheck, IconChevronDown } from '@tabler/icons-react'
import type { LaunchPatch, LaunchState } from '@evaos/contract'
import { APPROVAL_LABEL, type Approval } from '@evaos/chat-core/launch'
import { EvaPopover } from '../../overlay'

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
  const [opened, setOpened] = useState(false)
  const current = state?.approval ?? null
  return (
    <EvaPopover opened={opened && !disabled} onChange={setOpened} position="top-start">
      <EvaPopover.Target>
        <button
          type="button"
          className="eva-toolbar-btn eva-label"
          data-testid="composer-access"
          aria-disabled={disabled}
          aria-label="Access mode"
          onClick={() => {
            if (!disabled) setOpened((o) => !o)
          }}
        >
          <span>{current ? APPROVAL_LABEL[current] : 'Access'}</span>
          <IconChevronDown size={14} />
        </button>
      </EvaPopover.Target>
      <EvaPopover.Dropdown>
        <div className="eva-picker-list" role="listbox" aria-label="Access mode">
          {ORDER.map((a) => (
            <button
              key={a}
              type="button"
              role="option"
              aria-selected={current === a}
              className="eva-picker-item eva-label"
              data-testid={`access-option-${a}`}
              onClick={() => {
                setOpened(false)
                if (current !== a) onChange({ approval: a })
              }}
            >
              <span className="eva-picker-check">
                {current === a ? <IconCheck size={14} /> : null}
              </span>
              <span className="eva-picker-name">{APPROVAL_LABEL[a]}</span>
            </button>
          ))}
        </div>
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}
