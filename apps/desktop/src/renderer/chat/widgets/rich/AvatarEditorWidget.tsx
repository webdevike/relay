import { useContext, useEffect, useMemo, useState } from 'react'
import {
  ActionIcon,
  Button,
  ColorSwatch,
  Group,
  SegmentedControl,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core'
import { IconCheck, IconDice5 } from '@tabler/icons-react'
import {
  ACCENT_SWATCHES,
  COLOR_ROWS,
  PAPER_SWATCHES,
  PART_DEFS,
  PORTRAIT_STYLES,
  colorValue,
  partChoices,
  partThumbSvg,
  partValue,
  pinPortrait,
  saveMessage,
  shortName,
  shuffle,
  shufflePart,
  withColor,
  withPalette,
  withPart,
  withStyle,
  type PartDef,
  type Portrait,
} from '@relay/portrait-motion'
import type { AvatarEditorSpec } from '@evaos/chat-core/widget'
import { AvatarPreview } from '../../../assistants/AvatarPreview'
import { agentTitle, useNamesVersion } from '../../../eva/names-store'
import { dismissLocalRow } from '../../local-rows'
import { WidgetScope, useWidgetActions } from '../actions'
import { WidgetTitle } from './parts'
import './avatar-editor.css'

const STYLE_LABEL = { micah: 'Micah', notionists: 'Notionists' } as const
const PREVIEW = 176
/** Line art is black, so thumbnails sit on a light ground in both color schemes. */
const THUMB_GROUND = '#f1f3f5'

/** What each open editor holds, by message and agent, so a row scrolled out of the log and back keeps its edits. */
const drafts = new Map<string, Portrait>()

const svgUri = (svg: string): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

/**
 * The avatar editor: a big animated preview (Idle or Talking), the DiceBear style, a shuffle for
 * the whole face or one part, a picker per part with thumbnails, colors (the style's, the disc,
 * the animation accent), and Save and Cancel. Save sends `Save my avatar: {json}` as the next
 * message so the assistant applies it; Cancel closes an editor the header opened and resets one
 * the assistant wrote. Everything draws locally: no network.
 */
export function AvatarEditorWidget({ spec }: { spec: AvatarEditorSpec }) {
  useNamesVersion()
  const scope = useContext(WidgetScope)
  const { reply, canReply } = useWidgetActions()
  const start = useMemo(() => pinPortrait(spec.current as Portrait), [spec.current])
  const key = scope === null ? null : `${scope}|${spec.agent}`
  const [draft, setDraft] = useState<Portrait>(
    () => (key === null ? undefined : drafts.get(key)) ?? start,
  )
  const [face, setFace] = useState<'idle' | 'talking'>('idle')
  const [partKey, setPartKey] = useState<string>('hair')
  const [sent, setSent] = useState(false)
  useEffect(() => {
    if (key !== null) drafts.set(key, draft)
  }, [key, draft])

  const defs = PART_DEFS[draft.style]
  const def = defs.find((d) => d.key === partKey) ?? defs[0]!
  const changed = JSON.stringify(draft) !== JSON.stringify(start)
  const name = agentTitle(spec.agent) ?? spec.agent

  const save = (): void => {
    reply(saveMessage(spec.agent, draft))
    setSent(true)
    if (scope !== null) dismissLocalRow(scope)
  }
  const cancel = (): void => {
    if (scope !== null) dismissLocalRow(scope)
    setDraft(start)
  }

  return (
    <Stack gap="sm" data-testid="avatar-editor" data-agent={spec.agent}>
      <Group justify="space-between" wrap="nowrap">
        <WidgetTitle>{`${name}'s avatar`}</WidgetTitle>
        <SegmentedControl
          size="xs"
          value={draft.style}
          onChange={(v) => setDraft(withStyle(draft, v as Portrait['style']))}
          data={PORTRAIT_STYLES.map((s) => ({ value: s, label: STYLE_LABEL[s] }))}
          aria-label="Style"
          data-testid="avatar-editor-style"
        />
      </Group>
      <Group align="flex-start" gap="md" wrap="wrap">
        <Stack gap="xs" align="center" className="eva-ae-preview">
          <AvatarPreview
            portrait={draft}
            size={PREVIEW}
            face={face}
            testId="avatar-editor-preview"
          />
          <SegmentedControl
            size="xs"
            value={face}
            onChange={(v) => setFace(v as 'idle' | 'talking')}
            data={[
              { value: 'idle', label: 'Idle' },
              { value: 'talking', label: 'Talking' },
            ]}
            aria-label="Preview"
            data-testid="avatar-editor-face"
          />
          <Button
            size="xs"
            variant="default"
            leftSection={<IconDice5 size={16} stroke={1.5} />}
            onClick={() => setDraft(shuffle(draft))}
            data-testid="avatar-editor-shuffle"
          >
            Shuffle
          </Button>
        </Stack>
        <Stack gap="xs" className="eva-ae-controls">
          <Group gap="xs" role="tablist" aria-label="Parts">
            {defs.map((d) => (
              <Button
                key={d.key}
                size="compact-xs"
                variant={d.key === def.key ? 'filled' : 'default'}
                role="tab"
                aria-selected={d.key === def.key}
                onClick={() => setPartKey(d.key)}
                data-testid={`avatar-editor-part-${d.key}`}
              >
                {d.label}
              </Button>
            ))}
          </Group>
          <Group justify="space-between" wrap="nowrap">
            <Text size="xs" c="dimmed" data-testid="avatar-editor-part-value">
              {`${def.label}: ${shortName(partValue(draft, def.key))}`}
            </Text>
            <Tooltip label={`Shuffle ${def.label.toLowerCase()}`}>
              <ActionIcon
                size="sm"
                variant="subtle"
                aria-label={`Shuffle ${def.label.toLowerCase()}`}
                onClick={() => setDraft(shufflePart(draft, def.key))}
                data-testid="avatar-editor-part-shuffle"
              >
                <IconDice5 size={16} stroke={1.5} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <Thumbs draft={draft} def={def} onPick={(v) => setDraft(withPart(draft, def.key, v))} />
        </Stack>
      </Group>
      <Stack gap="xs">
        {COLOR_ROWS[draft.style].map((row) => (
          <Swatches
            key={row.key}
            label={row.label}
            colors={row.swatches.map((c) => `#${c}`)}
            value={colorValue(draft, row.key)}
            onPick={(c) => setDraft(withColor(draft, row.key, c))}
          />
        ))}
        <Swatches
          label="Background"
          colors={PAPER_SWATCHES}
          value={draft.colors?.paper ?? null}
          onPick={(c) => setDraft(withPalette(draft, 'paper', c))}
        />
        <Swatches
          label="Accent"
          colors={ACCENT_SWATCHES}
          value={draft.colors?.accent ?? null}
          onPick={(c) => setDraft(withPalette(draft, 'accent', c))}
        />
      </Stack>
      <Group justify="flex-end" gap="xs">
        {sent ? (
          <Text size="xs" c="dimmed" data-testid="avatar-editor-sent">
            {`Sent to ${name}`}
          </Text>
        ) : null}
        <Button
          size="xs"
          variant="subtle"
          onClick={cancel}
          disabled={sent}
          data-testid="avatar-editor-cancel"
        >
          Cancel
        </Button>
        <Button
          size="xs"
          onClick={save}
          disabled={sent || !canReply || !changed}
          data-testid="avatar-editor-save"
        >
          Save
        </Button>
      </Group>
    </Stack>
  )
}

/** Thumbnails of every variant of one part, each on the rest of the face; the pick is outlined. */
function Thumbs({
  draft,
  def,
  onPick,
}: {
  draft: Portrait
  def: PartDef
  onPick: (value: string | null) => void
}) {
  const now = partValue(draft, def.key)
  // A pick changes only this part, which every thumbnail overrides: draw them again only when the rest changes.
  const rest = JSON.stringify([draft.style, draft.seed, withPart(draft, def.key, null).options])
  const thumbs = useMemo(
    () =>
      partChoices(draft.style, def.key).map((value) => ({
        value,
        src: svgUri(partThumbSvg(draft, def, value)),
      })),
    [rest, def.key],
  )
  return (
    <div
      className="eva-ae-thumbs"
      role="listbox"
      aria-label={def.label}
      style={{ '--eva-ae-ground': draft.colors?.paper ?? THUMB_GROUND } as React.CSSProperties}
      data-testid="avatar-editor-thumbs"
    >
      {thumbs.map(({ value, src }) => (
        <button
          key={value ?? 'none'}
          type="button"
          role="option"
          aria-selected={value === now}
          aria-label={`${def.label} ${shortName(value)}`}
          className="eva-ae-thumb"
          onClick={() => onPick(value)}
          data-testid="avatar-editor-thumb"
        >
          <img src={src} alt="" draggable={false} />
          <span>{shortName(value)}</span>
        </button>
      ))}
    </div>
  )
}

function Swatches({
  label,
  colors,
  value,
  onPick,
}: {
  label: string
  colors: readonly string[]
  value: string | null
  onPick: (hex: string) => void
}) {
  return (
    <Group gap="xs" wrap="nowrap" align="center">
      <Text size="xs" c="dimmed" className="eva-ae-swatch-label">
        {label}
      </Text>
      <Group gap="xs" role="group" aria-label={label}>
        {colors.map((c) => {
          const on = value?.toLowerCase() === c.toLowerCase()
          return (
            <ColorSwatch
              key={c}
              component="button"
              type="button"
              color={c}
              size={22}
              aria-label={`${label} ${c}`}
              aria-pressed={on}
              className="eva-ae-swatch"
              onClick={() => onPick(c)}
            >
              {on ? <IconCheck size={12} stroke={3} color="#000" /> : null}
            </ColorSwatch>
          )
        })}
      </Group>
    </Group>
  )
}
