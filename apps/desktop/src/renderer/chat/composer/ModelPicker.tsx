import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ActionIcon, Button, Slider, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core'
import {
  IconBrandOpenai,
  IconChevronDown,
  IconRotate,
  IconSearch,
  IconStar,
  IconStarFilled,
} from '@tabler/icons-react'
import type { LaunchPatch, LaunchState } from '@evaos/contract'
import type { ModelInfo } from '@evaos/chat-core/launch'
import { IconAnthropic } from '../../brand/ProviderIcon'
import { registerPageChord } from '../../hotkeys/router'
import { EvaPopover } from '../../overlay'
import { startSettings, toggleFavorite, useSettings } from '../../settings/settings-store'
import './model-picker.css'

const slug = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, '-')
/** The starred tab's key; provider ids are never empty. */
const FAVORITES = ''
const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-codex': 'Codex',
  xai: 'xAI',
}

/** A thinking level or provider id as a label: `xhigh` reads Extra high, else capitalised. */
export function thinkingLabel(level: string): string {
  return level === 'xhigh' ? 'Extra high' : level.charAt(0).toUpperCase() + level.slice(1)
}

function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider] ?? thinkingLabel(provider)
}

/** The provider's brand mark (Anthropic's in its orange, others in currentColor), or null. */
export function providerLogo(provider: string, size: number): ReactNode {
  if (provider === 'anthropic')
    return <IconAnthropic size={size} className="eva-brand-anthropic" aria-hidden />
  if (provider === 'openai' || provider === 'openai-codex')
    return <IconBrandOpenai size={size} stroke={1.5} aria-hidden />
  return null
}

/**
 * The composer's model picker, after the native EvaOS one: tabs (starred, then each provider),
 * search, the models with ⌘1-⌘9 and a star, then the thinking level with a reset and a stepped
 * slider. ⌘1-⌘9 pick the open tab's first nine models while this composer (or no other) has focus.
 */
export function ModelPicker({
  state,
  models,
  defaultThinking,
  disabled,
  onChange,
}: {
  state: LaunchState | null
  models: readonly ModelInfo[]
  /** omp's configured default level: the reset target. */
  defaultThinking: string | null
  disabled: boolean
  onChange: (patch: LaunchPatch) => void
}) {
  const [opened, setOpened] = useState(false)
  const [tab, setTab] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState(0)
  const [drag, setDrag] = useState<number | null>(null)
  const anchor = useRef<HTMLButtonElement>(null)
  const favorites = useSettings((s) => s.favorite_models)
  useEffect(() => {
    void startSettings()
  }, [])

  const current = state?.model ?? null
  const info = current
    ? models.find((m) => m.provider === current[0] && m.id === current[1])
    : undefined
  const isCurrent = (m: ModelInfo): boolean =>
    current !== null && current[0] === m.provider && current[1] === m.id
  const levels = info?.levels ?? []
  const thinking = levels.length > 0 ? (state?.thinking ?? null) : null
  const level = thinking ?? defaultThinking
  const levelIx = level === null ? -1 : levels.indexOf(level)

  const providers = [...new Set(models.map((m) => m.provider))]
  const starred = favorites.flatMap((spec) => {
    const m = models.find((x) => `${x.provider}/${x.id}` === spec)
    return m ? [m] : []
  })
  // Opens on Starred when anything is starred, else the first provider omp lists.
  const active = tab ?? (starred.length > 0 ? FAVORITES : (providers[0] ?? FAVORITES))
  const listed = active === FAVORITES ? starred : models.filter((m) => m.provider === active)
  const needle = query.trim().toLowerCase()
  // Searching looks through every model; otherwise the tab's, numbered for ⌘1-⌘9.
  const rows = needle
    ? models.filter((m) => m.name.toLowerCase().includes(needle) || m.id.includes(needle))
    : listed

  const choose = (m: ModelInfo): void => {
    setOpened(false)
    if (!isCurrent(m)) onChange({ model: { provider: m.provider, modelId: m.id } })
  }
  const pickNth = useRef<(n: number) => boolean>(() => false)
  pickNth.current = (n) => {
    const m = listed[n]
    if (disabled || !m) return false
    choose(m)
    return true
  }
  useEffect(() => {
    const offs = Array.from({ length: 9 }, (_, i) =>
      registerPageChord(`cmd+${i + 1}`, () => {
        const root = anchor.current?.closest('.eva-composer')
        const focused = document.activeElement?.closest('.eva-composer')
        // Another composer has focus, or this one is in a hidden page: not ours.
        if (!root || (focused && focused !== root) || root.closest('[hidden], [inert]'))
          return false
        return pickNth.current(i) ? 'consumed' : false
      }),
    )
    return () => offs.forEach((off) => off())
  }, [])

  const open = opened && !disabled
  const shownIx = drag ?? levelIx
  const canReset =
    defaultThinking !== null && level !== defaultThinking && levels.includes(defaultThinking)
  const highlighted = Math.min(hover, rows.length - 1)

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      const n = rows.length
      setHover((h) => (n === 0 ? 0 : (Math.min(h, n - 1) + step + n) % n))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const m = rows[highlighted]
      if (m) choose(m)
    }
  }

  return (
    <EvaPopover
      opened={open}
      onChange={setOpened}
      position="top-end"
      width={340}
      trapFocus
      returnFocus
    >
      <EvaPopover.Target>
        <Button
          ref={anchor}
          variant="subtle"
          color="gray"
          size="compact-sm"
          fw={400}
          maw="100%"
          data-testid="composer-model"
          aria-label="Model"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-disabled={disabled}
          disabled={disabled}
          rightSection={<IconChevronDown size={12} />}
          onClick={() => {
            setQuery('')
            setHover(0)
            setOpened((o) => !o)
          }}
        >
          <span className="eva-model-trigger-name">
            {info?.name ?? current?.[1] ?? 'Default model'}
          </span>
          {thinking !== null ? (
            <span className="eva-model-trigger-level">{thinkingLabel(thinking)}</span>
          ) : null}
        </Button>
      </EvaPopover.Target>
      <EvaPopover.Dropdown p={0} className="eva-model-picker" data-testid="model-picker">
        <div className="eva-model-tabs" role="tablist" aria-label="Model groups">
          {[FAVORITES, ...providers].map((p) => {
            const selected = p === active
            const label = p === FAVORITES ? 'Starred' : providerLabel(p)
            const logo = p === FAVORITES ? null : providerLogo(p, 16)
            return (
              <Tooltip key={p} label={label} openDelay={400}>
                <UnstyledButton
                  className="eva-model-tab"
                  role="tab"
                  aria-selected={selected}
                  aria-label={label}
                  data-active={selected || undefined}
                  data-testid={`model-tab-${p === FAVORITES ? 'starred' : slug(p)}`}
                  onClick={() => {
                    setTab(p)
                    setQuery('')
                    setHover(0)
                  }}
                >
                  {p === FAVORITES ? (
                    selected ? (
                      <IconStarFilled size={16} aria-hidden />
                    ) : (
                      <IconStar size={16} stroke={1.5} aria-hidden />
                    )
                  ) : (
                    (logo ?? <span className="eva-model-tab-text">{label}</span>)
                  )}
                </UnstyledButton>
              </Tooltip>
            )
          })}
        </div>
        <TextInput
          className="eva-model-search"
          classNames={{ input: 'eva-model-search-input' }}
          variant="unstyled"
          size="sm"
          data-autofocus
          aria-label="Search models"
          placeholder={
            active === FAVORITES ? 'Search starred...' : `Search ${providerLabel(active)}...`
          }
          leftSection={<IconSearch size={14} />}
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value)
            setHover(0)
          }}
          onKeyDown={onSearchKey}
          data-testid="model-search"
        />
        <div className="eva-model-list" role="listbox" aria-label="Models">
          {rows.length === 0 ? (
            <Text className="eva-model-empty" size="xs" c="dimmed">
              {needle
                ? 'No models match.'
                : active === FAVORITES
                  ? 'Star a model to keep it here.'
                  : 'No models.'}
            </Text>
          ) : null}
          {rows.map((m, i) => {
            const spec = `${m.provider}/${m.id}`
            const star = favorites.includes(spec)
            const selected = isCurrent(m)
            return (
              <div
                key={spec}
                className="eva-model-row"
                role="option"
                aria-selected={selected}
                data-current={selected || undefined}
                data-hovered={i === highlighted || undefined}
                data-testid={`model-option-${slug(m.provider)}-${slug(m.id)}`}
                onMouseEnter={() => setHover(i)}
                onClick={() => choose(m)}
              >
                <span className="eva-model-row-logo">{providerLogo(m.provider, 14)}</span>
                <span className="eva-model-row-name">{m.name}</span>
                {selected && thinking !== null ? (
                  <span className="eva-model-row-level">{thinkingLabel(thinking)}</span>
                ) : null}
                <span className="eva-model-row-fill" />
                {!needle && i < 9 ? <span className="eva-model-kbd">⌘ {i + 1}</span> : null}
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  className="eva-model-star"
                  data-starred={star || undefined}
                  aria-label={star ? `Unstar ${m.name}` : `Star ${m.name}`}
                  aria-pressed={star}
                  data-testid={`model-star-${slug(m.provider)}-${slug(m.id)}`}
                  onClick={(e) => {
                    // A star press stays a star press, not a model pick.
                    e.stopPropagation()
                    void toggleFavorite(spec)
                  }}
                >
                  {star ? (
                    <IconStarFilled size={14} aria-hidden />
                  ) : (
                    <IconStar size={14} stroke={1.5} aria-hidden />
                  )}
                </ActionIcon>
              </div>
            )
          })}
        </div>
        <div className="eva-model-thinking">
          <div className="eva-model-thinking-head">
            <span className="eva-model-thinking-side" />
            <span className="eva-model-thinking-label" data-testid="thinking-level">
              {levels.length === 0
                ? 'No thinking levels'
                : shownIx >= 0
                  ? thinkingLabel(levels[shownIx] ?? '')
                  : 'Default thinking'}
            </span>
            <span className="eva-model-thinking-side">
              <Tooltip
                label={
                  defaultThinking === null
                    ? "omp's default thinking level is not set"
                    : `Back to omp's default (${thinkingLabel(defaultThinking)})`
                }
                openDelay={400}
              >
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  aria-label="Reset thinking level"
                  className="eva-model-reset"
                  data-testid="thinking-reset"
                  disabled={!canReset}
                  onClick={() => {
                    if (canReset && defaultThinking !== null)
                      onChange({ thinking: defaultThinking })
                  }}
                >
                  <IconRotate size={14} />
                </ActionIcon>
              </Tooltip>
            </span>
          </div>
          {levels.length > 1 ? (
            <Slider
              className="eva-model-slider"
              classNames={{
                track: 'eva-model-slider-track',
                bar: 'eva-model-slider-bar',
                thumb: 'eva-model-slider-thumb',
                mark: 'eva-model-slider-mark',
              }}
              data-testid="thinking-slider"
              thumbLabel="Thinking level"
              min={0}
              max={levels.length - 1}
              step={1}
              thumbSize={28}
              label={null}
              restrictToMarks
              marks={levels.map((_, i) => ({ value: i }))}
              value={Math.max(shownIx, 0)}
              onChange={setDrag}
              onChangeEnd={(v) => {
                setDrag(null)
                const next = levels[v]
                if (next !== undefined && next !== thinking) onChange({ thinking: next })
              }}
            />
          ) : null}
        </div>
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}
