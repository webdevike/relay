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
} from '@mantine/core'
import { IconDice5, IconSparkles } from '@tabler/icons-react'
import {
  STUDIO_ASPECTS,
  studioFrameSlots,
  studioResolutions,
  studioSeconds,
  type StudioAspect,
  type StudioAsset,
  type StudioBackend,
  type StudioBackendId,
  type StudioFrameSlot,
  type StudioMode,
} from '@evaos/contract'
import { creditsLabel as credits } from './studio-assets'
import type { StudioForm, StudioSlot } from './studio-form'
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
  const ofMode = backends.filter((b) => b.mode === form.mode)
  const byId = new Map(ofMode.map((b) => [b.id, b]))
  const models = backend?.models?.filter((m) => m.mode === form.mode) ?? []
  const resolutions = backend ? studioResolutions(backend, form.aspect, model) : []
  const lengths = backend && form.mode === 'video' ? studioSeconds(backend, model) : []
  const slots = backend && form.mode === 'video' ? studioFrameSlots(backend, model) : []
  const refSlots = backend && backend.mode === 'image' ? backend.refs : 0
  const set = (patch: Partial<StudioForm>): void => onChange((f) => ({ ...f, ...patch }))
  return (
    <div className="eva-studio-composer" data-testid="studio-composer">
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
      <SegmentedControl<StudioMode>
        fullWidth
        value={form.mode}
        data-testid="studio-mode"
        data={[
          { label: 'Image', value: 'image' },
          { label: 'Video', value: 'video' },
        ]}
        onChange={(mode) => set({ mode })}
      />
      <Select<StudioBackendId>
        label="Backend"
        data-testid="studio-backend"
        value={form.backend}
        allowDeselect={false}
        checkIconPosition="right"
        comboboxProps={{ withinPortal: true, zIndex: 300 }}
        data={ofMode.map((b) => ({ value: b.id, label: b.label, disabled: !b.available }))}
        rightSection={
          backend ? <span className="eva-studio-pill">{backend.paid ? 'Paid' : 'Free'}</span> : null
        }
        rightSectionWidth={56}
        rightSectionPointerEvents="none"
        renderOption={({ option }) => {
          const b = byId.get(option.value)
          return (
            <div className="eva-studio-option" data-disabled={option.disabled ? 'true' : undefined}>
              <span className="eva-studio-option-main">
                <span>{option.label}</span>
                <span className="eva-studio-pill">{b?.paid ? 'Paid' : 'Free'}</span>
              </span>
              {b && !b.available && b.reason ? (
                <span className="eva-studio-option-note">{b.reason}</span>
              ) : null}
            </div>
          )
        }}
        onChange={(id) => id && set({ backend: id })}
      />
      {models.length > 0 ? (
        <div className="eva-studio-field">
          <Select
            label="Model"
            data-testid="studio-model"
            value={form.model}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true, zIndex: 300 }}
            data={models.map((m) => ({ value: m.id, label: m.name }))}
            renderOption={({ option }) => (
              <div className="eva-studio-option-main">
                <span>{option.label}</span>
                {quotes[option.value] !== undefined ? (
                  <span className="eva-studio-option-note">
                    {credits(quotes[option.value] ?? 0)}
                  </span>
                ) : null}
              </div>
            )}
            onChange={(v) => v && set({ model: v })}
          />
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
        </div>
      ) : null}
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
        ) : problem && form.prompt.trim() !== '' ? (
          <span className="eva-studio-faint" data-testid="studio-problem">
            {problem}
          </span>
        ) : null}
      </div>
    </div>
  )
}
