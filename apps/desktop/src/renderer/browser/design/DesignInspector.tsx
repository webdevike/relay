import { useState } from 'react'
import { ActionIcon, Button, Loader, Textarea, Tooltip, UnstyledButton } from '@mantine/core'
import { IconArrowBackUp, IconBrush, IconSend, IconX } from '@tabler/icons-react'
import { useSelector } from '@xstate/react'
import { DESIGN_STYLE_KEYS, type DesignItem, type DesignStyleKey } from '@evaos/contract'
import { DISMISS_PRIORITY, useDismissable } from '../../hotkeys/dismiss'
import { hasRequest, type StyleEdit } from './design-mode.machine'
import { designActorOf, type DesignActor } from './design-runtime'
import { DesignAnnotate } from './DesignAnnotate'
import './design.css'

function sourceText(item: DesignItem): string | null {
  const s = item.source
  if (!s) return null
  const file = s.file.split('/').slice(-2).join('/')
  return s.line === null ? file : `${file}:${s.line}`
}

/** One style row: the computed value, editable in place; Enter or leaving the field previews it. */
function StyleRow(props: {
  actor: DesignActor
  item: DesignItem
  property: DesignStyleKey
  edit: StyleEdit | undefined
}) {
  const { actor, item, property, edit } = props
  const value = edit?.to ?? item.styles[property] ?? ''
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft === null) return
    const next = draft.trim()
    setDraft(null)
    if (next !== '' && next !== value)
      actor.send({ type: 'style.edit', selector: item.selector, property, value: next })
  }
  return (
    <div className="eva-design-style" data-edited={edit ? true : undefined}>
      <label className="eva-design-style-key" htmlFor={`design-${property}`} title={property}>
        {property}
      </label>
      <input
        id={`design-${property}`}
        className="eva-design-style-value"
        data-testid={`design-style-${property}`}
        spellCheck={false}
        value={draft ?? value}
        title={edit ? `Was ${edit.from}` : value}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      {edit ? (
        <Tooltip label={`Back to ${edit.from}`} openDelay={400}>
          <ActionIcon
            variant="subtle"
            size={22}
            aria-label={`Undo ${property}`}
            onClick={() =>
              actor.send({
                type: 'style.edit',
                selector: item.selector,
                property,
                value: edit.from,
              })
            }
          >
            <IconArrowBackUp size={14} />
          </ActionIcon>
        </Tooltip>
      ) : null}
    </div>
  )
}

/**
 * Design Mode's panel beside page `tabId` (the native page paints over anything drawn on it):
 * the selected elements, the focused one's source, screenshot and computed styles (editable),
 * and the change to send to the workspace's chat. Esc exits the mode.
 */
export function DesignInspector({ tabId, visible }: { tabId: string; visible: boolean }) {
  const actor = designActorOf(tabId)
  const state = useSelector(actor, (s) => s)
  const ctx = state.context
  const exit = (): void => actor.send({ type: 'design.exit' })
  const drawing = state.matches({ on: 'drawing' })
  useDismissable(DISMISS_PRIORITY.selection, exit, visible && !drawing)

  const sending = state.matches({ on: 'sending' })
  const sent = state.matches({ on: { selected: 'sent' } })
  const canSend = state.matches({ on: { selected: 'editing' } }) && hasRequest(ctx)
  const item = ctx.items[ctx.focus]
  const send = (): void => actor.send({ type: 'request.send' })
  const drawnOrCrop = item ? (ctx.drawings[item.selector] ?? item.crop?.png) : undefined

  return (
    <aside className="eva-design" data-testid="design-inspector" aria-label="Design mode">
      <header className="eva-design-head">
        <span className="eva-design-title">Design mode</span>
        <Tooltip label="Exit (Esc)" openDelay={400}>
          <ActionIcon
            variant="subtle"
            size={24}
            aria-label="Exit design mode"
            data-testid="design-exit"
            onClick={exit}
          >
            <IconX size={14} />
          </ActionIcon>
        </Tooltip>
      </header>

      {ctx.items.length === 0 ? (
        <p className="eva-design-hint" data-testid="design-hint">
          Click an element in the page to select it. Shift-click adds or removes one.
        </p>
      ) : (
        <div className="eva-design-scroll">
          <ol className="eva-design-items" data-testid="design-items">
            {ctx.items.map((it, i) => (
              <li
                key={it.selector}
                className="eva-design-item"
                data-active={i === ctx.focus ? true : undefined}
                data-missing={it.missing ? true : undefined}
                data-testid="design-item"
              >
                <UnstyledButton
                  className="eva-design-item-main"
                  aria-pressed={i === ctx.focus}
                  onClick={() => actor.send({ type: 'item.focus', index: i })}
                >
                  <span className="eva-design-num">{i + 1}</span>
                  <span className="eva-design-item-text">
                    <span className="eva-design-label" data-testid="design-item-label">
                      {it.label}
                    </span>
                    <span className="eva-design-meta" data-testid="design-item-source">
                      {it.missing
                        ? 'Not in the page right now'
                        : [it.component, sourceText(it)].filter(Boolean).join(' · ') ||
                          'No source found'}
                    </span>
                  </span>
                </UnstyledButton>
                <ActionIcon
                  variant="subtle"
                  size={22}
                  aria-label={`Remove ${it.label}`}
                  data-testid="design-item-remove"
                  onClick={() => actor.send({ type: 'item.remove', selector: it.selector })}
                >
                  <IconX size={12} />
                </ActionIcon>
              </li>
            ))}
          </ol>

          {item && !item.missing ? (
            <section className="eva-design-detail" data-testid="design-detail">
              {item.source ? (
                <div
                  className="eva-design-source"
                  data-testid="design-source"
                  title={item.source.via === 'react-stack' ? 'Approximate line' : undefined}
                >
                  {item.source.line === null
                    ? item.source.file
                    : `${item.source.file}:${item.source.line}`}
                </div>
              ) : null}
              {drawnOrCrop ? (
                <div className="eva-design-crop">
                  <img
                    src={`data:image/png;base64,${drawnOrCrop}`}
                    alt={`Screenshot of ${item.label}`}
                    data-testid="design-crop"
                  />
                  <Button
                    variant="subtle"
                    size="compact-xs"
                    leftSection={<IconBrush size={12} />}
                    data-testid="design-draw"
                    onClick={() => actor.send({ type: 'draw.open', selector: item.selector })}
                  >
                    {ctx.drawings[item.selector] ? 'Drawn on' : 'Draw on it'}
                  </Button>
                </div>
              ) : null}
              <div className="eva-design-styles" data-testid="design-styles">
                {DESIGN_STYLE_KEYS.filter((k) => item.styles[k] !== undefined).map((k) => (
                  <StyleRow
                    key={`${item.selector}|${k}|${item.styles[k] ?? ''}`}
                    actor={actor}
                    item={item}
                    property={k}
                    edit={ctx.edits.find((e) => e.selector === item.selector && e.property === k)}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}

      <footer className="eva-design-foot">
        <Textarea
          size="xs"
          autosize
          minRows={2}
          maxRows={6}
          placeholder={
            ctx.items.length ? 'Describe the change, like "8px tighter"' : 'Select an element first'
          }
          aria-label="Change to make"
          data-testid="design-instruction"
          disabled={ctx.items.length === 0 || sending}
          value={ctx.instruction}
          onChange={(e) => actor.send({ type: 'instruction.change', text: e.currentTarget.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              send()
            }
          }}
        />
        <div className="eva-design-send-row">
          <span className="eva-design-status" data-testid="design-status" role="status">
            {sending ? (
              <>
                <Loader size={10} /> Sending to the chat
              </>
            ) : ctx.error ? (
              <span className="eva-design-error">{ctx.error}</span>
            ) : sent ? (
              'Sent. The selection stays while the page reloads.'
            ) : ctx.edits.length ? (
              `${ctx.edits.length} style ${ctx.edits.length === 1 ? 'edit' : 'edits'}`
            ) : null}
          </span>
          <Button
            size="compact-sm"
            rightSection={<IconSend size={13} />}
            data-testid="design-send"
            disabled={!canSend}
            onClick={send}
          >
            Send
          </Button>
        </div>
      </footer>

      {drawing && ctx.drawingOf ? (
        <DesignAnnotate
          png={ctx.drawingFrom ?? ''}
          onDone={(png) => actor.send({ type: 'draw.done', png })}
          onCancel={() => actor.send({ type: 'draw.cancel' })}
        />
      ) : null}
    </aside>
  )
}
