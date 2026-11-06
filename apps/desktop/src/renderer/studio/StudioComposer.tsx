import {
  ActionIcon,
  Button,
  Chip,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  Textarea,
  Tooltip,
  UnstyledButton,
} from '@mantine/core'
import { IconDice5, IconSparkles } from '@tabler/icons-react'
import {
  STUDIO_ASPECTS,
  studioFrameSlots,
  studioRefs,
  studioResolutions,
  studioSeconds,
  type StudioAspect,
  type StudioAsset,
  type StudioBackend,
  type StudioFrameSlot,
  type StudioInput,
} from '@evaos/contract'
import { useEffect, useMemo, useRef, useState } from 'react'
import { creditsLabel as credits } from './studio-assets'
import {
  STUDIO_GROUPS,
  formEntryKey,
  formModel,
  selectEntry,
  studioEntries,
  studioPresets,
  studioTab,
  tabChoice,
  type StudioForm,
  type StudioSlot,
  type StudioTab,
} from './studio-form'
import { StudioSlotTile } from './StudioSlotTile'

const SLOT_LABEL: Record<StudioFrameSlot, string> = {
  start: 'Start',
  mid: 'Mid',
  end: 'End',
}

export interface StudioComposerProps {
  form: StudioForm
  backend: StudioBackend | null
  backends: readonly StudioBackend[]
  assets: ReadonlyMap<string, StudioAsset>
  /** Credits per Higgsfield model for the current settings, when quoted. */
  quotes: Readonly<Record<string, number>>
  /** The paid backend's credits left, when known. */
  balance: number | undefined
  /** Why Generate cannot go yet. */
  problem: string | null
  /** The last refusal (create, upload). */
  error: string | null
  busy: boolean
  /** The slot an upload is on its way into (`start`, `ref:0`...). */
  uploading: string | null
  onChange: (update: (form: StudioForm) => StudioForm) => void
  onGenerate: () => void
  onFile: (slot: StudioSlot, index: number, file: File) => void
  onPick: (slot: StudioSlot, index: number) => void
}

export function StudioComposer({
  form,
  backend,
  backends,
  assets,
  quotes,
  balance,
  problem,
  error,
  busy,
  uploading,
  onChange,
  onGenerate,
  onFile,
  onPick,
}: StudioComposerProps) {
  const model = form.model ?? undefined
  const entries = useMemo(() => studioEntries(backends), [backends])
  const byKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries])
  const { presets, reason: presetsReason } = useMemo(() => studioPresets(backends), [backends])
  const preset = formModel(form, backend)
  const derived = studioTab(form)
  // A tab with nothing to pick yet (no ComfyUI presets) still shows, until the form moves.
  const [pending, setPending] = useState<StudioTab | null>(null)
  useEffect(() => setPending(null), [derived])
  const tab = pending ?? derived
  const entryKey = formEntryKey(form, backends)
  const entryValue = tab === 'models' ? entryKey : null
  // The last choice made on each tab, to come back to when switching.
  const last = useRef<Record<StudioTab, string | null>>({ models: null, comfyui: null })
  useEffect(() => {
    last.current[derived] = entryKey
  }, [derived, entryKey])
  const switchTab = (next: StudioTab): void => {
    setPending(next)
    const choice = tabChoice(next, backends, last.current[next])
    if (choice) onChange((f) => selectEntry(f, backends, choice))
  }
  const resolutions = backend ? studioResolutions(backend, form.aspect, model) : []
  const lengths = backend && form.mode === 'video' ? studioSeconds(backend, model) : []
  const slots = backend && form.mode === 'video' ? studioFrameSlots(backend, model) : []
  const refSlots = backend && form.mode === 'image' ? studioRefs(backend, model).max : 0
  const set = (patch: Partial<StudioForm>): void => onChange((f) => ({ ...f, ...patch }))
  return (
    <div className="eva-studio-composer" data-testid="studio-composer">
      {preset?.prompt === false ? null : (
        <Textarea
          aria-label="Prompt"
          placeholder={
            form.mode === 'video' ? 'Describe the video to make' : 'Describe the image to make'
          }
          autosize
          minRows={3}
          maxRows={12}
          value={form.prompt}
          data-testid="studio-prompt"
          onChange={(e) => set({ prompt: e.currentTarget.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && problem === null && !busy) {
              e.preventDefault()
              onGenerate()
            }
          }}
        />
      )}
      <SegmentedControl<StudioTab>
        fullWidth
        value={tab}
        data-testid="studio-tab"
        data={[
          { label: 'Models', value: 'models' },
          { label: 'ComfyUI', value: 'comfyui' },
        ]}
        onChange={switchTab}
      />
      {tab === 'models' ? (
        <div className="eva-studio-field">
          <Select
            label="Model"
            data-testid="studio-model"
            value={entryValue}
            allowDeselect={false}
            checkIconPosition="right"
            comboboxProps={{ withinPortal: true, zIndex: 300 }}
            maxDropdownHeight={420}
            data={STUDIO_GROUPS.flatMap((group) => {
              const items = entries
                .filter((e) => e.group === group)
                .map((e) => ({ value: e.key, label: e.label, disabled: !e.available }))
              return items.length > 0 ? [{ group, items }] : []
            })}
            renderOption={({ option }) => {
              const e = byKey.get(option.value)
              const quote = e?.model != null ? quotes[e.model] : undefined
              return (
                <div
                  className="eva-studio-option"
                  data-disabled={option.disabled ? 'true' : undefined}
                >
                  <span className="eva-studio-option-main">
                    <span>{option.label}</span>
                    {e?.paid ? (
                      quote !== undefined ? (
                        <span className="eva-studio-option-note">{credits(quote)}</span>
                      ) : (
                        <span className="eva-studio-pill">Paid</span>
                      )
                    ) : null}
                  </span>
                  {e && !e.available && e.reason ? (
                    <span className="eva-studio-option-note">{e.reason}</span>
                  ) : null}
                </div>
              )
            }}
            onChange={(key) => {
              const e = key ? byKey.get(key) : undefined
              if (e) onChange((f) => selectEntry(f, backends, e))
            }}
          />
          {backend?.paid ? (
            <span className="eva-studio-faint" data-testid="studio-balance">
              {[
                form.model && quotes[form.model] !== undefined
                  ? `${credits(quotes[form.model] ?? 0)} for this job`
                  : null,
                balance !== undefined ? `${credits(balance)} left` : null,
              ]
                .filter(Boolean)
                .join(', ')}
            </span>
          ) : null}
        </div>
      ) : presets.length > 0 ? (
        <div className="eva-studio-field">
          <span className="eva-studio-label">Preset</span>
          <div className="eva-studio-presets" data-testid="studio-presets">
            {presets.map((p) => {
              const active = p.backend === form.backend && p.model === form.model
              return (
                <UnstyledButton
                  key={p.key}
                  className="eva-studio-preset"
                  data-active={active ? 'true' : undefined}
                  data-testid={`studio-preset-${p.model}`}
                  aria-pressed={active}
                  onClick={() => onChange((f) => selectEntry(f, backends, p))}
                >
                  <span className="eva-studio-preset-name">{p.label}</span>
                  {p.description ? (
                    <span className="eva-studio-preset-note">{p.description}</span>
                  ) : null}
                </UnstyledButton>
              )
            })}
          </div>
        </div>
      ) : (
        <span className="eva-studio-faint" data-testid="studio-presets-empty">
          {presetsReason}
        </span>
      )}
      {preset?.inputs?.map((input) => (
        <PresetInput
          key={input.id}
          input={input}
          value={form.params[input.id] ?? input.default}
          onChange={(value) =>
            onChange((f) => ({ ...f, params: { ...f.params, [input.id]: value } }))
          }
        />
      ))}
      <div className="eva-studio-field">
        <span className="eva-studio-label">Aspect</span>
        <Chip.Group<false, StudioAspect>
          multiple={false}
          value={form.aspect}
          onChange={(aspect) => set({ aspect })}
        >
          <Group gap="xs">
            {STUDIO_ASPECTS.map((a) => (
              <Chip key={a} value={a} size="xs" data-testid={`studio-aspect-${a}`}>
                {a}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      </div>
      {resolutions.length > 0 ? (
        <div className="eva-studio-field">
          <span className="eva-studio-label">Resolution</span>
          <Chip.Group
            multiple={false}
            value={form.resolution ?? ''}
            onChange={(v) => set({ resolution: v })}
          >
            <Group gap="xs">
              {resolutions.map((r) => (
                <Chip key={r.id} value={r.id} size="xs">
                  {r.label}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
        </div>
      ) : null}
      {lengths.length > 0 ? (
        <div className="eva-studio-field">
          <span className="eva-studio-label">Length</span>
          <Chip.Group
            multiple={false}
            value={form.seconds === null ? '' : String(form.seconds)}
            onChange={(v) => set({ seconds: Number(v) })}
          >
            <Group gap="xs">
              {lengths.map((s) => (
                <Chip key={s} value={String(s)} size="xs">
                  {`${s} s`}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
        </div>
      ) : null}
      {backend?.seed ? (
        <div className="eva-studio-field">
          <span className="eva-studio-label">Seed</span>
          <Group gap="xs" wrap="nowrap">
            <NumberInput
              className="eva-studio-grow"
              aria-label="Seed"
              placeholder="Random"
              min={0}
              max={2_147_483_647}
              allowDecimal={false}
              allowNegative={false}
              hideControls
              value={form.seed ?? ''}
              onChange={(v) => set({ seed: typeof v === 'number' ? v : null })}
            />
            <Tooltip label="Random seed" openDelay={400}>
              <ActionIcon
                variant="default"
                size="lg"
                aria-label="Random seed"
                disabled={form.seed === null}
                onClick={() => set({ seed: null })}
              >
                <IconDice5 size={16} stroke={1.5} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </div>
      ) : null}
      {slots.length > 0 ? (
        <div className="eva-studio-field">
          <span className="eva-studio-label">Keyframes</span>
          <div className="eva-studio-slots">
            {slots.map((slot) => {
              const id = form.frames[slot]
              return (
                <StudioSlotTile
                  key={slot}
                  label={SLOT_LABEL[slot]}
                  testid={`studio-slot-${slot}`}
                  asset={id ? (assets.get(id) ?? null) : null}
                  busy={uploading === slot}
                  onFile={(file) => onFile(slot, 0, file)}
                  onPick={() => onPick(slot, 0)}
                  onClear={() =>
                    onChange((f) => {
                      const { [slot]: _gone, ...frames } = f.frames
                      return { ...f, frames }
                    })
                  }
                />
              )
            })}
          </div>
        </div>
      ) : null}
      {refSlots > 0 ? (
        <div className="eva-studio-field">
          <span className="eva-studio-label">Reference images</span>
          <div className="eva-studio-slots">
            {Array.from({ length: Math.min(refSlots, form.refs.length + 1) }, (_, i) => {
              const id = form.refs[i]
              return (
                <StudioSlotTile
                  key={id ?? `add-${i}`}
                  label={`Reference ${i + 1}`}
                  testid={`studio-slot-ref-${i}`}
                  asset={id ? (assets.get(id) ?? null) : null}
                  busy={uploading === `ref:${i}`}
                  onFile={(file) => onFile('ref', i, file)}
                  onPick={() => onPick('ref', i)}
                  onClear={() =>
                    onChange((f) => ({ ...f, refs: f.refs.filter((_, at) => at !== i) }))
                  }
                />
              )
            })}
          </div>
        </div>
      ) : null}
      <div className="eva-studio-go">
        <Button
          fullWidth
          leftSection={<IconSparkles size={16} stroke={1.5} />}
          disabled={problem !== null}
          loading={busy}
          data-testid="studio-generate"
          onClick={onGenerate}
        >
          Generate
        </Button>
        {error ? (
          <span className="eva-studio-error" data-testid="studio-error">
            {error}
          </span>
        ) : problem && (preset?.prompt === false || form.prompt.trim() !== '') ? (
          <span className="eva-studio-faint" data-testid="studio-problem">
            {problem}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** One of a preset's own inputs: chips for a short choice, a menu for a long one, a number box. */
function PresetInput({
  input,
  value,
  onChange,
}: {
  input: StudioInput
  value: string | number
  onChange: (value: string | number) => void
}) {
  if (input.kind === 'number') {
    return (
      <div className="eva-studio-field">
        <span className="eva-studio-label">{input.label}</span>
        <NumberInput
          aria-label={input.label}
          data-testid={`studio-param-${input.id}`}
          min={input.min}
          max={input.max}
          step={input.step}
          clampBehavior="strict"
          decimalScale={4}
          value={value}
          onChange={(v) => typeof v === 'number' && onChange(v)}
        />
      </div>
    )
  }
  if (input.options.length > 6) {
    return (
      <Select
        label={input.label}
        data-testid={`studio-param-${input.id}`}
        value={String(value)}
        allowDeselect={false}
        comboboxProps={{ withinPortal: true, zIndex: 300 }}
        data={input.options.map((o) => ({ value: o.id, label: o.label }))}
        onChange={(v) => v && onChange(v)}
      />
    )
  }
  return (
    <div className="eva-studio-field">
      <span className="eva-studio-label">{input.label}</span>
      <Chip.Group multiple={false} value={String(value)} onChange={(v) => onChange(v)}>
        <Group gap="xs" data-testid={`studio-param-${input.id}`}>
          {input.options.map((o) => (
            <Chip key={o.id} value={o.id} size="xs">
              {o.label}
            </Chip>
          ))}
        </Group>
      </Chip.Group>
    </div>
  )
}
