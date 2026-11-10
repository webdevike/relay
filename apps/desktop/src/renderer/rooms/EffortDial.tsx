import { ActionIcon, Button, SegmentedControl, Slider, Tooltip } from '@mantine/core'
import { IconChevronDown, IconRotate } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import {
  COUNCIL_DEFAULT_EFFORT,
  COUNCIL_DEFAULT_ROUTING,
  COUNCIL_MODELS,
  COUNCIL_HARNESS_LABEL,
  COUNCIL_NOTCHES,
  COUNCIL_PAUSE_AT,
  COUNCIL_ROLE_LABEL,
  COUNCIL_ROUTE_LABEL,
  COUNCIL_THINKING_LABEL,
  councilApprox,
  councilCast,
  councilChip,
  councilLabel,
  councilMoney,
  councilNotch,
  councilTime,
  type CouncilCast,
  type CouncilProvider,
  type CouncilRouting,
} from '@relay/protocol'
import { EvaPopover } from '../overlay'
import { PartPill, ProviderMark, RolePill, SeatAvatar, first, modelLine } from './council-bits'
import { clampRaise, withProvider } from './council-view'

export interface EffortDialProps {
  /** The notch: the form's pick before Start, the room's own once it runs. */
  effort: number
  routing: CouncilRouting
  /** Before Start: any notch, any routing. */
  onChange?: (next: { effort: number; routing: CouncilRouting }) => void
  /** In a running room: locked downward, up one notch at a time through onRaise; routing is fixed. */
  live?: boolean
  onRaise?: () => Promise<string | null>
  position?: 'bottom-start' | 'bottom-end'
  testid?: string
}

const stripTilde = (s: string): string => s.replace(/^~/, '')
/** "21 min to 53 min", "1.4 h to 3.6 h". */
const timeRange = (lo: number, hi: number): string =>
  `${stripTilde(councilTime(lo))} to ${stripTilde(councilTime(hi))}`

function Estimate({ cast }: { cast: CouncilCast }) {
  return (
    <div className="eva-dial-est" data-testid="dial-estimate">
      <div>
        <b data-testid="dial-cost">{councilApprox(cast.cost)}</b>
        <span>
          {councilMoney(cast.costLow)} to {councilMoney(cast.costHigh)} list
        </span>
      </div>
      <div>
        <b data-testid="dial-time">{councilTime(cast.minutes)}</b>
        <span>{timeRange(cast.minutesLow, cast.minutesHigh)}</span>
      </div>
      <div>
        <b data-testid="dial-rounds">
          {cast.notch.rounds} {cast.notch.rounds === 1 ? 'round' : 'rounds'}
        </b>
        <span>
          {cast.seats.length} {cast.seats.length === 1 ? 'seat' : 'seats'}, {cast.harnesses}{' '}
          {cast.harnesses === 1 ? 'harness' : 'harnesses'}
        </span>
      </div>
    </div>
  )
}

function RoutingTable({
  cast,
  routing,
  disabled,
  onChange,
}: {
  cast: CouncilCast
  routing: CouncilRouting
  disabled: boolean
  onChange: (next: CouncilRouting) => void
}) {
  const moved = cast.overrides.length
  return (
    <section className="eva-dial-sec" data-testid="dial-routing">
      <div className="eva-dial-sec-head">
        <span>Routing</span>
        <span className="eva-dial-sec-side">
          {moved > 0 ? `${moved} overridden` : 'By model strength'}
          {moved > 0 && !disabled ? (
            <Button
              variant="subtle"
              color="gray"
              size="compact-sm"
              onClick={() => onChange({ ...COUNCIL_DEFAULT_ROUTING })}
              data-testid="dial-routing-default"
            >
              default
            </Button>
          ) : null}
        </span>
      </div>
      <div className="eva-dial-route">
        {cast.roles.map((role) => (
          <div
            key={role}
            className="eva-dial-route-row"
            data-moved={cast.overrides.includes(role) || undefined}
          >
            <span className="eva-dial-route-what">
              <span>{COUNCIL_ROUTE_LABEL[role]}</span>
              <span className="eva-dial-dim">{COUNCIL_ROLE_LABEL[role]}</span>
            </span>
            <SegmentedControl
              size="sm"
              disabled={disabled}
              value={routing[role]}
              aria-label={`${COUNCIL_ROLE_LABEL[role]} provider`}
              data-testid={`dial-route-${role}`}
              onChange={(v) => onChange(withProvider(routing, role, v as CouncilProvider))}
              data={(['anthropic', 'openai'] as const).map((p) => ({
                value: p,
                label: (
                  <span className="eva-dial-prov">
                    <ProviderMark provider={p} size={12} />
                    {p === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                  </span>
                ),
              }))}
            />
          </div>
        ))}
      </div>
    </section>
  )
}

function PartsRow({ cast }: { cast: CouncilCast }) {
  if (!cast.split) return null
  return (
    <section className="eva-dial-sec" data-testid="dial-parts">
      <div className="eva-dial-sec-head">
        <span>Parts, built in parallel</span>
      </div>
      <div className="eva-dial-parts">
        {cast.parts.map((part) => (
          <div key={part} className="eva-dial-part">
            <b>{part}</b>
            {cast.seats
              .filter((s) => s.part === part && (s.role === 'builder' || s.role === 'look'))
              .map((s) => (
                <small key={s.id}>
                  {first(s.name)} · {COUNCIL_MODELS[s.model].short} ·{' '}
                  {COUNCIL_HARNESS_LABEL[s.harness]}
                  {s.branch ? ` (${s.branch})` : ''}
                </small>
              ))}
          </div>
        ))}
      </div>
    </section>
  )
}

function SeatList({ cast }: { cast: CouncilCast }) {
  return (
    <section className="eva-dial-sec" data-testid="dial-seats">
      <div className="eva-dial-sec-head">
        <span>Seats</span>
      </div>
      <div className="eva-dial-seats">
        {cast.seats.map((s) => (
          <div key={s.id} className="eva-dial-seat" data-testid={`dial-seat-${s.id}`}>
            <SeatAvatar name={s.name} color={s.color} model={s.model} />
            <div className="eva-dial-who">
              <span className="eva-dial-who-line">
                <b>{first(s.name)}</b>
                <RolePill role={s.role} />
                {s.part && cast.split ? <PartPill part={s.part} branch={s.branch} /> : null}
              </span>
              <span className="eva-dial-dim">
                {modelLine(s.model, s.harness)}
                {s.override ? <span className="eva-dial-override"> · routing override</span> : null}
              </span>
            </div>
            <span className="eva-dial-think">{COUNCIL_THINKING_LABEL[s.thinking]}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

/** The notch's own sentence, what every seat may do, and the hard cap. */
function Foot({ cast }: { cast: CouncilCast }) {
  return (
    <div className="eva-dial-foot">
      <p>{cast.notch.blurb}</p>
      <p>
        Every seat runs with its harness's full toolset in its own worktree. Pushes, deploys, posts,
        purchases and deletes outside the room ask you first.
      </p>
      <p>
        Hard cap {councilMoney(cast.cap)}. The room pauses at {Math.round(COUNCIL_PAUSE_AT * 100)}%
        of it and asks before spending more.
      </p>
    </div>
  )
}

/**
 * The stepped slider of the composer's thinking picker (ModelPicker.tsx), one dot per notch:
 * label centered above, reset on the right, arrows step, Home and End jump.
 */
function NotchSlider({
  value,
  resetTo,
  onPreview,
  onCommit,
  clamp,
  resetLabel,
}: {
  value: number
  resetTo: number
  onPreview: (effort: number) => void
  onCommit: (effort: number) => void
  clamp: (effort: number) => number
  resetLabel: string
}) {
  const [drag, setDrag] = useState<number | null>(null)
  const shown = drag ?? value
  return (
    <div className="eva-dial-thinking">
      <div className="eva-dial-thinking-head">
        <span className="eva-dial-thinking-side" />
        <span className="eva-dial-thinking-label" data-testid="dial-label">
          {councilLabel(shown)}
        </span>
        <span className="eva-dial-thinking-side">
          <Tooltip label={resetLabel} openDelay={400}>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="md"
              aria-label="Reset effort"
              className="eva-dial-reset"
              data-testid="dial-reset"
              disabled={value === resetTo}
              onClick={() => onCommit(resetTo)}
            >
              <IconRotate size={14} />
            </ActionIcon>
          </Tooltip>
        </span>
      </div>
      <div className="eva-dial-rail">
        <Slider
          className="eva-dial-slider"
          classNames={{
            track: 'eva-dial-slider-track',
            bar: 'eva-dial-slider-bar',
            thumb: 'eva-dial-slider-thumb',
            mark: 'eva-dial-slider-mark',
          }}
          data-testid="dial-slider"
          thumbLabel="Room effort"
          min={0}
          max={COUNCIL_NOTCHES.length - 1}
          step={1}
          thumbSize={28}
          label={null}
          restrictToMarks
          marks={COUNCIL_NOTCHES.map((_, i) => ({ value: i }))}
          value={shown - 1}
          onChange={(v) => {
            const e = clamp(v + 1)
            setDrag(e)
            onPreview(e)
          }}
          onChangeEnd={(v) => {
            setDrag(null)
            onCommit(clamp(v + 1))
          }}
        />
        <div className="eva-dial-names" aria-hidden>
          {COUNCIL_NOTCHES.map((n, i) => (
            <span
              key={n.effort}
              style={{ left: `${(i / (COUNCIL_NOTCHES.length - 1)) * 100}%` }}
              data-on={n.effort === shown || undefined}
            >
              {n.name}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * The room's effort chip and its popover: the notch slider, what the notch costs and how long it
 * takes (live as you drag), routing by model strength, the parts and the seats. Before Start the
 * dial is free; in a running room it only goes up, one notch at a time.
 */
export function EffortDial({
  effort,
  routing,
  onChange,
  live = false,
  onRaise,
  position = 'bottom-end',
  testid = 'effort-dial',
}: EffortDialProps) {
  const [opened, setOpened] = useState(false)
  const [preview, setPreview] = useState(effort)
  const [raising, setRaising] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The room moved (our raise landed): the preview follows.
  useEffect(() => setPreview(effort), [effort])

  const shown = live ? preview : effort
  const now = councilCast(effort, routing)
  const cast = councilCast(shown, routing)
  const up = live && shown > effort
  const clamp = (e: number): number => (live ? clampRaise(effort, e) : e)

  const raise = async (): Promise<void> => {
    if (!onRaise) return
    setRaising(true)
    setError(null)
    const err = await onRaise()
    setRaising(false)
    if (err) setError(err)
    else setOpened(false)
  }

  return (
    <EvaPopover
      opened={opened}
      onChange={setOpened}
      position={position}
      width={500}
      middlewares={{
        flip: true,
        shift: { padding: 8 },
        // The popover scrolls inside the space the window leaves it.
        size: {
          padding: 12,
          apply({ availableHeight, elements }) {
            elements.floating.style.maxHeight = `${Math.max(260, Math.min(780, availableHeight))}px`
          },
        },
      }}
      trapFocus
      returnFocus
    >
      <EvaPopover.Target>
        <button
          type="button"
          className="eva-dial-chip"
          aria-haspopup="dialog"
          aria-expanded={opened}
          aria-label={`Room effort: ${councilChip(now)}`}
          data-testid={testid}
          onClick={() => setOpened((o) => !o)}
        >
          <span className="eva-dial-dots" aria-hidden>
            {COUNCIL_NOTCHES.map((n) => (
              <i key={n.effort} data-on={n.effort <= effort || undefined} />
            ))}
          </span>
          <span className="eva-dial-chip-text">{councilChip(now)}</span>
          <IconChevronDown size={12} aria-hidden />
        </button>
      </EvaPopover.Target>
      <EvaPopover.Dropdown p={0} className="eva-dial-pop" data-testid={`${testid}-popover`}>
        <NotchSlider
          value={shown}
          resetTo={live ? effort : COUNCIL_DEFAULT_EFFORT}
          resetLabel={
            live
              ? `Back to ${councilNotch(effort).name}, where the room is`
              : `Back to ${councilNotch(COUNCIL_DEFAULT_EFFORT).name}, the default`
          }
          clamp={clamp}
          onPreview={(e) => {
            if (live) setPreview(e)
          }}
          onCommit={(e) => {
            if (live) setPreview(e)
            else onChange?.({ effort: e, routing })
          }}
        />
        <div className="eva-dial-body">
          <Estimate cast={cast} />
          {live ? (
            <div className="eva-dial-raise" data-testid="dial-raise">
              <span>
                {up
                  ? `Bring in more people: ${councilNotch(shown).name} adds seats from the next round, with the whole feed.`
                  : 'The room only goes up from here, one notch at a time.'}
              </span>
              {up ? (
                <Button
                  size="sm"
                  loading={raising}
                  onClick={() => void raise()}
                  data-testid="dial-raise-go"
                >
                  Raise to {councilNotch(shown).name}
                </Button>
              ) : null}
              {error ? (
                <span className="eva-dial-error" role="alert">
                  {error}
                </span>
              ) : null}
            </div>
          ) : null}
          <RoutingTable
            cast={cast}
            routing={routing}
            disabled={live}
            onChange={(r) => onChange?.({ effort, routing: r })}
          />
          <PartsRow cast={cast} />
          <SeatList cast={cast} />
          <Foot cast={cast} />
        </div>
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}
