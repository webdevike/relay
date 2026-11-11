import { useMemo, useState, type KeyboardEvent } from 'react'
import { Text, TextInput, UnstyledButton } from '@mantine/core'
import { IconChevronDown, IconSearch } from '@tabler/icons-react'
import type { ModelInfo } from '@evaos/chat-core/launch'
import { providerLogo } from '../chat/composer/ModelPicker'
import '../chat/composer/model-picker.css'
import { EvaPopover } from '../overlay'
import { familiesOf, specOf } from './model-catalog'

/**
 * A member's exact model: the button shows its name and its omp id; the list is omp's catalog by
 * family, searchable by name or id, each row with both.
 */
export function RoomModelPicker({
  value,
  models,
  onChange,
  testid,
}: {
  /** `provider/id`. */
  value: string
  models: readonly ModelInfo[]
  onChange: (spec: string) => void
  testid: string
}) {
  const [opened, setOpened] = useState(false)
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState(0)
  const current = models.find((m) => specOf(m) === value)
  const needle = query.trim().toLowerCase()
  const groups = useMemo(
    () =>
      familiesOf(
        needle === ''
          ? models
          : models.filter(
              (m) =>
                m.name.toLowerCase().includes(needle) || specOf(m).toLowerCase().includes(needle),
            ),
      ),
    [models, needle],
  )
  const rows = groups.flatMap((g) => g.models)
  const highlighted = Math.min(hover, rows.length - 1)
  const choose = (m: ModelInfo): void => {
    setOpened(false)
    onChange(specOf(m))
  }
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = rows.length
      const step = e.key === 'ArrowDown' ? 1 : -1
      setHover((h) => (n === 0 ? 0 : (Math.min(h, n - 1) + step + n) % n))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const m = rows[highlighted]
      if (m) choose(m)
    }
  }
  return (
    <EvaPopover opened={opened} onChange={setOpened} position="bottom-start" width={360} trapFocus>
      <EvaPopover.Target>
        <UnstyledButton
          className="eva-room-model"
          data-testid={testid}
          aria-label="Model"
          aria-haspopup="dialog"
          aria-expanded={opened}
          onClick={() => {
            setQuery('')
            setHover(0)
            setOpened((o) => !o)
          }}
        >
          <span className="eva-room-model-name">{current?.name ?? value}</span>
          <span className="eva-room-model-id">{value}</span>
          <IconChevronDown size={12} aria-hidden />
        </UnstyledButton>
      </EvaPopover.Target>
      <EvaPopover.Dropdown p={0} className="eva-model-picker" data-testid={`${testid}-list`}>
        <TextInput
          className="eva-model-search"
          classNames={{ input: 'eva-model-search-input' }}
          variant="unstyled"
          size="sm"
          data-autofocus
          aria-label="Search models"
          placeholder="Search models or ids"
          leftSection={<IconSearch size={14} />}
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value)
            setHover(0)
          }}
          onKeyDown={onSearchKey}
          data-testid={`${testid}-search`}
        />
        <div className="eva-model-list" role="listbox" aria-label="Models">
          {rows.length === 0 ? (
            <Text className="eva-model-empty" size="xs" c="dimmed">
              No models match.
            </Text>
          ) : null}
          {groups.map((g) => (
            <div key={g.family} role="group" aria-label={g.family}>
              <div className="eva-room-model-family">{g.family}</div>
              {g.models.map((m) => {
                const spec = specOf(m)
                const i = rows.indexOf(m)
                return (
                  <div
                    key={spec}
                    className="eva-model-row"
                    role="option"
                    aria-selected={spec === value}
                    data-current={spec === value || undefined}
                    data-hovered={i === highlighted || undefined}
                    data-testid={`${testid}-option-${spec}`}
                    onMouseEnter={() => setHover(i)}
                    onClick={() => choose(m)}
                  >
                    <span className="eva-model-row-logo">{providerLogo(m.provider, 14)}</span>
                    <span className="eva-model-row-name">{m.name}</span>
                    <span className="eva-model-row-fill" />
                    <span className="eva-room-model-id">{spec}</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}
