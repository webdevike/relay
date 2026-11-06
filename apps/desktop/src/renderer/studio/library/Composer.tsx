import { useEffect, useMemo, useRef, useState } from 'react'
import { NumberInput, SegmentedControl, Tooltip } from '@mantine/core'
import {
  IconAdjustmentsHorizontal,
  IconCheck,
  IconChevronDown,
  IconFolder,
  IconInbox,
  IconPhotoPlus,
  IconPlus,
  IconSparkles,
} from '@tabler/icons-react'
import { STUDIO_ASPECTS, STUDIO_UNSORTED, MAX_STUDIO_COUNT, type StudioSpec } from '@evaos/contract'
import { EvaMenu, EvaPopover } from '../../overlay'
import { StudioConfirm, type StudioQuote } from '../StudioConfirm'
import { studioRequest } from '../studio-store'
import { createJobs, newProjectModal, plural, projectName, toast, useLibrary } from './actions'
import {
  createChoices,
  modelOf,
  refsUseKlein,
  routeCreate,
  type CreateChoice,
  type RoutedCreate,
} from './create-models'
import { destinationOf, localStore, openView, setComposer, useLocal, VIEW_FAV } from './local'
import { AtPicker, RefChips } from './menus'

const RECENT_IMAGES = 14
const PROMPT_MAX_HEIGHT = 140

/** The create bar: prompt, @ references, model, aspect, count, settings, project, Generate. */
export function Composer() {
  const c = useLocal((s) => s.composer)
  const view = useLocal((s) => s.view)
  const { items, projects, references, backends } = useLibrary()
  const choices = useMemo(() => createChoices(backends), [backends])
  const choice: CreateChoice | undefined = choices.find((x) => x.key === c.choice) ?? choices[0]
  const dest = destinationOf(
    { view, composer: c },
    projects.map((p) => p.id),
  )
  const [at, setAt] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [aspectOpen, setAspectOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [destOpen, setDestOpen] = useState(false)
  const [confirm, setConfirm] = useState<RoutedCreate | null>(null)
  const [quote, setQuote] = useState<StudioQuote>({ state: 'asking' })
  const [busy, setBusy] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (c.focus > 0) ta.current?.focus()
  }, [c.focus])

  const backend = choice ? backends.find((b) => b.id === choice.backend) : undefined
  const stepsInput = modelOf(backend, choice?.model)?.inputs?.find(
    (i) => i.id === 'steps' && i.kind === 'number',
  )
  const routed = choice
    ? routeCreate(
        {
          choice,
          prompt: c.prompt,
          aspect: c.aspect,
          refs: c.refs,
          ...(c.seedMode === 'fixed' ? { seed: c.seed } : {}),
          steps: c.steps,
        },
        backends,
        references,
      )
    : 'This Relay host has no image models'
  const blocked = typeof routed === 'string' ? routed : (choice?.off ?? null)

  const queue = async (r: RoutedCreate, credits?: number): Promise<boolean> => {
    const spec: StudioSpec = credits === undefined ? r.spec : { ...r.spec, confirmCredits: credits }
    const a = await createJobs({
      spec,
      count: c.count,
      project: dest,
      ...(r.parent ? { parent: r.parent } : {}),
    })
    if (!a.ok) {
      setConfirmError(a.error ?? null)
      return false
    }
    setComposer({ prompt: '', refs: [] })
    if (ta.current) ta.current.style.height = 'auto'
    toast(`Queued ${plural(c.count, 'image')}`, undefined, 2500)
    const s = localStore.getState()
    if (s.view === VIEW_FAV) openView(dest === STUDIO_UNSORTED ? 'all' : dest)
    else if (s.view !== 'all' && s.view !== dest) {
      toast(`Queued in ${projectName(dest, projects)}`, {
        label: 'Open',
        run: () => openView(dest),
      })
    }
    document.querySelector('.sl-feed')?.scrollTo({ top: 0, behavior: 'smooth' })
    return true
  }

  const run = async (): Promise<void> => {
    if (blocked !== null || typeof routed === 'string' || !choice) {
      if (blocked) toast(blocked, undefined, 3000)
      return
    }
    if (!choice.paid) {
      await queue(routed)
      return
    }
    setConfirm(routed)
    setConfirmError(null)
    setQuote({ state: 'asking' })
    const a = await studioRequest({ kind: 'quote', spec: routed.spec })
    setQuote(
      a.ok && a.credits !== undefined
        ? { state: 'ready', credits: a.credits, balance: a.balance ?? backend?.balance }
        : { state: 'failed', error: a.error ?? `${choice.label} didn't give a price.` },
    )
  }

  const groups = [...new Set(choices.map((x) => x.group))]
  const recent = items
    .filter((i) => i.asset.kind === 'image')
    .slice(0, RECENT_IMAGES)
    .map((i) => ({ id: i.asset.id, thumb: i.asset.thumb }))
  const addRef = (id: string): void => {
    const { refs } = localStore.getState().composer
    if (!refs.includes(id)) setComposer({ refs: [...refs, id] })
  }
  const closeAt = (): void => {
    setAt(false)
    const { prompt } = localStore.getState().composer
    if (prompt.endsWith('@')) setComposer({ prompt: prompt.slice(0, -1) })
  }

  return (
    <div className="sl-composer" data-testid="studio-composer">
      {at ? (
        <AtPicker
          images={recent}
          onImage={addRef}
          onReference={(r) => addRef(r.asset.id)}
          onDone={closeAt}
        />
      ) : null}
      <RefChips
        ids={c.refs}
        onRemove={(id) => setComposer({ refs: c.refs.filter((x) => x !== id) })}
      />
      <div className="sl-composer-top">
        <Tooltip label="Add a reference" openDelay={400}>
          <button
            type="button"
            className="sl-chip-btn sl-icon"
            aria-label="Add a reference"
            data-testid="studio-add-ref"
            onClick={() => setAt((o) => !o)}
          >
            <IconPhotoPlus size={18} />
          </button>
        </Tooltip>
        <textarea
          ref={ta}
          className="sl-prompt"
          rows={1}
          value={c.prompt}
          aria-label="Prompt"
          data-testid="studio-prompt"
          placeholder={
            c.refs.length ? 'Describe what to make with the references' : 'Describe what to make'
          }
          onChange={(e) => {
            const value = e.currentTarget.value
            if (value.endsWith('@') && !c.prompt.endsWith('@')) setAt(true)
            setComposer({ prompt: value })
            e.currentTarget.style.height = 'auto'
            e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, PROMPT_MAX_HEIGHT)}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void run()
            } else if (e.key === 'Escape' && at) {
              e.stopPropagation()
              closeAt()
            }
          }}
        />
      </div>
      <div className="sl-composer-row">
        <span className="sl-dim sl-small sl-with">Create with</span>
        <EvaPopover opened={modelOpen} onChange={setModelOpen} position="top-start" width={300}>
          <EvaPopover.Target>
            <button
              type="button"
              className={`sl-chip-btn${modelOpen ? ' on' : ''}`}
              aria-label="Model"
              data-testid="studio-model"
              onClick={() => setModelOpen((o) => !o)}
            >
              {choice?.label ?? 'No model'}
              <IconChevronDown size={13} />
            </button>
          </EvaPopover.Target>
          <EvaPopover.Dropdown className="sl-pop">
            <div className="sl-pop-list">
              {groups.map((g) => (
                <div key={g}>
                  <div className="sl-menu-label">{g}</div>
                  {choices
                    .filter((x) => x.group === g)
                    .map((x) => (
                      <button
                        type="button"
                        key={x.key}
                        disabled={x.off !== undefined}
                        title={x.off}
                        className={`sl-menu-item${x.key === choice?.key ? ' on' : ''}`}
                        data-testid={`studio-model-${x.key}`}
                        onClick={() => {
                          setComposer({ choice: x.key, steps: null })
                          setModelOpen(false)
                        }}
                      >
                        <span className="sl-menu-main">
                          <span>{x.label}</span>
                          <span className="sl-dim sl-small">{x.off ?? x.note}</span>
                        </span>
                        {x.paid ? <span className="sl-badge">Paid</span> : null}
                        {x.key === choice?.key ? <IconCheck size={15} /> : null}
                      </button>
                    ))}
                </div>
              ))}
            </div>
          </EvaPopover.Dropdown>
        </EvaPopover>
        <EvaMenu opened={aspectOpen} onChange={setAspectOpen} position="top-start" width={150}>
          <EvaMenu.Target>
            <button
              type="button"
              className="sl-chip-btn"
              aria-label="Aspect ratio"
              onClick={() => setAspectOpen((o) => !o)}
            >
              {c.aspect}
              <IconChevronDown size={13} />
            </button>
          </EvaMenu.Target>
          <EvaMenu.Dropdown>
            {STUDIO_ASPECTS.map((a) => (
              <EvaMenu.Item
                key={a}
                onClick={() => setComposer({ aspect: a })}
                rightSection={a === c.aspect ? <IconCheck size={14} /> : null}
              >
                {a}
              </EvaMenu.Item>
            ))}
          </EvaMenu.Dropdown>
        </EvaMenu>
        <div className="sl-count" role="group" aria-label="Image count">
          {Array.from({ length: MAX_STUDIO_COUNT }, (_, i) => i + 1).map((n) => (
            <button
              type="button"
              key={n}
              className={c.count === n ? 'on' : ''}
              aria-pressed={c.count === n}
              onClick={() => setComposer({ count: n })}
            >
              {n}
            </button>
          ))}
        </div>
        <EvaPopover
          opened={settingsOpen}
          onChange={setSettingsOpen}
          position="top-start"
          width={260}
        >
          <EvaPopover.Target>
            <button
              type="button"
              className="sl-chip-btn sl-icon"
              aria-label="Settings"
              onClick={() => setSettingsOpen((o) => !o)}
            >
              <IconAdjustmentsHorizontal size={17} />
            </button>
          </EvaPopover.Target>
          <EvaPopover.Dropdown className="sl-pop sl-pad">
            <div className="sl-field">
              <span className="sl-flabel">Seed</span>
              <SegmentedControl
                size="xs"
                value={c.seedMode}
                onChange={(v) => setComposer({ seedMode: v === 'fixed' ? 'fixed' : 'random' })}
                data={[
                  { value: 'random', label: 'Random' },
                  { value: 'fixed', label: 'Fixed' },
                ]}
              />
              {c.seedMode === 'fixed' ? (
                <NumberInput
                  size="xs"
                  min={0}
                  aria-label="Seed"
                  value={c.seed}
                  onChange={(v) => setComposer({ seed: Number(v) || 0 })}
                />
              ) : null}
            </div>
            {stepsInput && stepsInput.kind === 'number' ? (
              <div className="sl-field">
                <span className="sl-flabel">{stepsInput.label}</span>
                <NumberInput
                  size="xs"
                  min={stepsInput.min}
                  max={stepsInput.max}
                  step={stepsInput.step}
                  aria-label={stepsInput.label}
                  value={c.steps ?? stepsInput.default}
                  onChange={(v) => setComposer({ steps: Number(v) || stepsInput.default })}
                />
              </div>
            ) : null}
          </EvaPopover.Dropdown>
        </EvaPopover>
        {refsUseKlein(choice, c.refs) ? (
          <span className="sl-dim sl-small" data-testid="studio-klein-hint">
            References use FLUX.2 klein
          </span>
        ) : null}
        <span className="sl-grow" />
        <EvaMenu opened={destOpen} onChange={setDestOpen} position="top-end" width={240}>
          <EvaMenu.Target>
            <button
              type="button"
              className="sl-dest"
              aria-label="Project"
              data-testid="studio-dest"
              onClick={() => setDestOpen((o) => !o)}
            >
              {dest === STUDIO_UNSORTED ? <IconInbox size={14} /> : <IconFolder size={14} />}
              <span className="sl-dest-name">{projectName(dest, projects)}</span>
              <IconChevronDown size={12} />
            </button>
          </EvaMenu.Target>
          <EvaMenu.Dropdown>
            <EvaMenu.Label>Save to</EvaMenu.Label>
            <EvaMenu.Item
              leftSection={<IconInbox size={15} />}
              onClick={() => setComposer({ dest: STUDIO_UNSORTED })}
              rightSection={dest === STUDIO_UNSORTED ? <IconCheck size={14} /> : null}
            >
              Unsorted
            </EvaMenu.Item>
            {projects.map((p) => (
              <EvaMenu.Item
                key={p.id}
                leftSection={<IconFolder size={15} />}
                onClick={() => setComposer({ dest: p.id })}
                rightSection={dest === p.id ? <IconCheck size={14} /> : null}
              >
                {p.name}
              </EvaMenu.Item>
            ))}
            <EvaMenu.Divider />
            <EvaMenu.Item
              leftSection={<IconPlus size={15} />}
              onClick={() => newProjectModal((id) => setComposer({ dest: id }))}
            >
              New project
            </EvaMenu.Item>
            <EvaMenu.Item
              rightSection={c.dest === 'auto' ? <IconCheck size={14} /> : null}
              onClick={() => setComposer({ dest: 'auto' })}
            >
              Follow the open project
            </EvaMenu.Item>
          </EvaMenu.Dropdown>
        </EvaMenu>
        <Tooltip label={blocked ?? ''} disabled={blocked === null} position="top">
          <button
            type="button"
            className="sl-go"
            aria-disabled={blocked !== null}
            data-testid="studio-generate"
            onClick={() => void run()}
          >
            <IconSparkles size={16} /> Generate {c.count}
          </button>
        </Tooltip>
      </div>
      <StudioConfirm
        opened={confirm !== null}
        backend={choice?.label ?? 'Paid'}
        quote={quote}
        count={c.count}
        busy={busy}
        error={confirmError}
        onClose={() => setConfirm(null)}
        onConfirm={(credits) => {
          if (!confirm) return
          setBusy(true)
          void queue(confirm, credits).then((ok) => {
            setBusy(false)
            if (ok) setConfirm(null)
          })
        }}
      />
    </div>
  )
}
