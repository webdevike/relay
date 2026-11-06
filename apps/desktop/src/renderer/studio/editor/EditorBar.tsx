import { useState, type RefObject } from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import { IconArrowUp, IconCheck, IconChevronDown } from '@tabler/icons-react'
import type { StudioReference, StudioSegment } from '@evaos/contract'
import { EvaMenu } from '../../overlay'
import { AtPicker, RefChips } from '../library/menus'
import { EDIT_ENGINES, type EditEngine } from './recipes'

const SUGGESTIONS = [
  'Make it night',
  'Change the background',
  'Add warm sunlight',
  'Turn it into a watercolor',
]

export interface EditorBarProps {
  input: RefObject<HTMLInputElement | null>
  prompt: string
  onPrompt: (prompt: string) => void
  engine: EditEngine
  onEngine: (engine: EditEngine) => void
  /** Asset ids picked with @: another version or a saved reference. */
  refs: readonly string[]
  onRefs: (refs: string[]) => void
  picking: boolean
  onPicking: (open: boolean) => void
  /** Other versions the @ picker offers. */
  images: Array<{ id: string; thumb: string }>
  segment: StudioSegment | undefined
  onClearSegment: () => void
  /** Why this version takes no edits (a video); undefined when it does. */
  locked: string | undefined
  /** A job of this version is queued or running, or an op is on its way. */
  busy: boolean
  onSend: () => void
}

/** The describe-your-edit pill: suggestions, chips, the @ picker, the engine and send. */
export function EditorBar(p: EditorBarProps) {
  const [engineMenu, setEngineMenu] = useState(false)
  const engine = EDIT_ENGINES.find((e) => e.id === p.engine)!
  const combining = p.refs.length > 0
  const chips = combining || p.segment !== undefined
  const canSend = p.locked === undefined && !p.busy && p.prompt.trim() !== ''
  const pickDone = (): void => {
    p.onPrompt(p.prompt.replace(/@$/, ''))
    p.onPicking(false)
    p.input.current?.focus()
  }

  return (
    <div className="ed-bottom">
      {!chips && !p.picking && p.prompt === '' && p.locked === undefined ? (
        <div className="ed-suggest" data-testid="studio-ed-suggestions">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                p.onPrompt(s)
                p.input.current?.focus()
              }}
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
      {chips ? (
        <div className="ed-chips">
          {combining ? (
            <>
              <RefChips
                ids={[...p.refs]}
                onRemove={(id) => p.onRefs(p.refs.filter((r) => r !== id))}
              />
              <span className="ed-hint">References use FLUX.2 klein</span>
            </>
          ) : null}
          {p.segment ? (
            <span className="ed-chip" data-testid="studio-ed-editing-only">
              Editing only: {p.segment.label}
              <i />
              <button
                type="button"
                onClick={p.onClearSegment}
                data-testid="studio-ed-clear-segment"
              >
                Clear
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
      {p.picking ? (
        <AtPicker
          images={p.images}
          onImage={(id) => p.onRefs([id])}
          onReference={(ref: StudioReference) => p.onRefs([ref.asset.id])}
          onDone={pickDone}
        />
      ) : null}
      <div className="ed-bar">
        {combining ? (
          <Tooltip label="References use FLUX.2 klein">
            <span className="ed-engine" data-locked="true" data-testid="studio-ed-engine">
              FLUX.2 klein
            </span>
          </Tooltip>
        ) : (
          <EvaMenu opened={engineMenu} onChange={setEngineMenu} position="top-start" offset={10}>
            <EvaMenu.Target>
              <button
                type="button"
                className="ed-engine"
                aria-label="Edit engine"
                data-testid="studio-ed-engine"
              >
                {engine.label}
                <IconChevronDown size={13} />
              </button>
            </EvaMenu.Target>
            <EvaMenu.Dropdown>
              {EDIT_ENGINES.map((e) => (
                <EvaMenu.Item
                  key={e.id}
                  onClick={() => p.onEngine(e.id)}
                  rightSection={e.id === p.engine ? <IconCheck size={14} /> : null}
                  data-testid={`studio-ed-engine-${e.id}`}
                >
                  {e.label} <span className="ed-hint">{e.where}</span>
                </EvaMenu.Item>
              ))}
            </EvaMenu.Dropdown>
          </EvaMenu>
        )}
        <input
          ref={p.input}
          value={p.prompt}
          disabled={p.locked !== undefined}
          onChange={(e) => {
            const v = e.target.value
            p.onPrompt(v)
            if (v.endsWith('@') && !p.prompt.endsWith('@')) p.onPicking(true)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
            e.preventDefault()
            if (canSend) p.onSend()
          }}
          placeholder={
            p.locked !== undefined
              ? p.locked
              : p.segment
                ? `Edit only ${p.segment.label}`
                : 'Describe your edit, @ to reference images'
          }
          aria-label="Describe your edit"
          data-testid="studio-ed-prompt"
        />
        <ActionIcon
          size={34}
          radius="xl"
          color="blue"
          variant="filled"
          onClick={p.onSend}
          disabled={!canSend}
          aria-label="Send"
          data-testid="studio-ed-send"
        >
          <IconArrowUp size={18} />
        </ActionIcon>
      </div>
    </div>
  )
}
