import {
  Alert,
  Anchor,
  Avatar,
  Badge,
  Blockquote,
  Divider,
  Group,
  List,
  Progress,
  Stack,
  Text,
  Timeline,
} from '@mantine/core'
import {
  IconAlertTriangle,
  IconCircle,
  IconCircleCheck,
  IconCircleCheckFilled,
  IconCircleX,
  IconInfoCircle,
} from '@tabler/icons-react'
import type {
  AvatarSpec,
  BadgeSpec,
  CalloutSpec,
  CodeSpec,
  LinkSpec,
  ListItem,
  ListSpec,
  ProgressSpec,
  QuoteSpec,
  RowsSpec,
  TextSpec,
  TimelineSpec,
  Tone,
} from '@evaos/chat-core/widget'
import { openLink } from '../../../navigation/open-link'
import { CodeBlock } from '../../markdown/CodeBlock'
import { mediaUrl } from '../media-url'
import { useToneColor, WidgetTitle } from '../rich/parts'

/** Text in a tone's readable shade; no tone keeps the surrounding color. */
export function useToneText(): (tone: Tone | undefined) => string | undefined {
  const color = useToneColor()
  return (tone) =>
    tone === undefined
      ? undefined
      : tone === 'muted'
        ? 'var(--mantine-color-dimmed)'
        : `var(--mantine-color-${color(tone)}-text)`
}

/** Type scale per text style; `display` is a calculator-style readout (large tabular numerals). */
const TEXT_STYLE = {
  heading: { size: 'md', fw: 600 },
  body: { size: 'sm' },
  caption: { size: 'xs', c: 'dimmed' },
  muted: { size: 'sm', c: 'dimmed' },
  display: { fz: 36, fw: 500, lh: 1.2 },
} as const satisfies Record<NonNullable<TextSpec['style']>, object>

export function TextBlock({ spec }: { spec: TextSpec }) {
  return (
    <Text
      {...TEXT_STYLE[spec.style ?? 'body']}
      ta={spec.align}
      className="eva-wb-text"
      data-testid="widget-text"
      data-style={spec.style}
    >
      {spec.text}
    </Text>
  )
}

/** Label left, value right, a hairline between rows. */
export function RowsBlock({ spec }: { spec: RowsSpec }) {
  const toneText = useToneText()
  return (
    <div className="eva-wb-rows" data-testid="widget-rows">
      {spec.rows.map((row, i) => (
        <div key={i} className="eva-wb-rows-row">
          <Text size="sm" truncate className="eva-wb-rows-label">
            {row.label}
          </Text>
          <Text size="sm" fw={500} c={toneText(row.tone)} className="eva-wb-rows-value">
            {row.value}
          </Text>
        </div>
      ))}
    </div>
  )
}

export function BadgeBlock({ spec }: { spec: BadgeSpec }) {
  const color = useToneColor()
  return (
    <Badge
      variant="light"
      color={color(spec.tone)}
      tt="none"
      fw={500}
      className="eva-wb-badge"
      data-testid="widget-badge"
    >
      {spec.label}
    </Badge>
  )
}

export function DividerBlock() {
  return <Divider className="eva-wb-divider" data-testid="widget-divider" />
}

export function LinkBlock({ spec }: { spec: LinkSpec }) {
  return (
    <Anchor
      href={spec.url}
      title={spec.url}
      size="sm"
      className="eva-wb-link"
      data-testid="widget-link"
      onClick={(e) => {
        e.preventDefault()
        openLink(spec.url)
      }}
    >
      {spec.label}
    </Anchor>
  )
}

/** A labelled bar with its rounded percent; the value is already clamped by the schema. */
export function ProgressBlock({ spec }: { spec: ProgressSpec }) {
  const color = useToneColor()
  const percent = Math.round((spec.value / spec.max) * 100)
  return (
    <Stack gap={6} className="eva-wb-progress" data-testid="widget-progress">
      <Group justify="space-between" gap="sm" wrap="nowrap">
        <Text size="sm" truncate>
          {spec.label ?? ''}
        </Text>
        <Text size="sm" c="dimmed" className="eva-wb-num">
          {percent}%
        </Text>
      </Group>
      <Progress
        value={percent}
        color={color(spec.tone)}
        size="sm"
        aria-label={spec.label ?? 'Progress'}
      />
      {spec.caption !== undefined ? (
        <Text size="xs" c="dimmed">
          {spec.caption}
        </Text>
      ) : null}
    </Stack>
  )
}

function itemParts(item: ListItem): {
  text: string
  caption?: string | undefined
  checked: boolean
} {
  return typeof item === 'string'
    ? { text: item, checked: false }
    : { text: item.text, caption: item.caption, checked: item.checked ?? false }
}

function ItemText({
  text,
  caption,
  done,
}: {
  text: string
  caption?: string | undefined
  done?: boolean
}) {
  return (
    <div className="eva-wb-item" data-done={done || undefined}>
      <Text size="sm" span className="eva-wb-item-text">
        {text}
      </Text>
      {caption !== undefined ? (
        <Text size="xs" c="dimmed">
          {caption}
        </Text>
      ) : null}
    </div>
  )
}

/** Bulleted, numbered, or a static checklist where done items mute and strike through. */
export function ListBlock({ spec }: { spec: ListSpec }) {
  const items = spec.items.map(itemParts)
  if (spec.style === 'check') {
    return (
      <Stack gap={6} className="eva-wb-checklist" data-testid="widget-list" role="list">
        {items.map((item, i) => (
          <Group key={i} gap={8} wrap="nowrap" align="flex-start" role="listitem">
            {item.checked ? (
              <IconCircleCheckFilled
                className="eva-wb-check"
                data-checked
                size={16}
                aria-label="Done"
              />
            ) : (
              <IconCircle className="eva-wb-check" size={16} stroke={1.5} aria-label="Not done" />
            )}
            <ItemText text={item.text} caption={item.caption} done={item.checked} />
          </Group>
        ))}
      </Stack>
    )
  }
  return (
    <List
      type={spec.style === 'number' ? 'ordered' : 'unordered'}
      size="sm"
      spacing={4}
      className="eva-wb-list"
      data-testid="widget-list"
    >
      {items.map((item, i) => (
        <List.Item key={i}>
          <ItemText text={item.text} caption={item.caption} />
        </List.Item>
      ))}
    </List>
  )
}

const CALLOUT_ICON = {
  ok: IconCircleCheck,
  warn: IconAlertTriangle,
  danger: IconCircleX,
  accent: IconInfoCircle,
  muted: IconInfoCircle,
} as const

/** A tinted note; the tone picks the icon. */
export function CalloutBlock({ spec }: { spec: CalloutSpec }) {
  const color = useToneColor()
  const Icon = CALLOUT_ICON[spec.tone]
  return (
    <Alert
      variant="light"
      color={color(spec.tone)}
      icon={<Icon size={18} stroke={1.75} />}
      title={spec.title}
      className="eva-wb-callout"
      data-testid="widget-callout"
    >
      {spec.text}
    </Alert>
  )
}

/** The `code` node: an optional title over the chat's own code block. */
export function CodeNodeBlock({ spec }: { spec: CodeSpec }) {
  return (
    <Stack gap={4} className="eva-wb-code" data-testid="widget-code">
      {spec.title !== undefined ? <WidgetTitle>{spec.title}</WidgetTitle> : null}
      <CodeBlock lang={spec.language ?? ''} code={spec.code} />
    </Stack>
  )
}

export function QuoteBlock({ spec }: { spec: QuoteSpec }) {
  return (
    <Blockquote
      cite={spec.cite}
      className="eva-wb-quote"
      data-testid="widget-quote"
      classNames={{ root: 'eva-wb-quote-root', cite: 'eva-wb-quote-cite' }}
    >
      {spec.text}
    </Blockquote>
  )
}

/** A person: photo (initials while it loads or when there is none), name, subtitle. */
export function AvatarBlock({ spec }: { spec: AvatarSpec }) {
  return (
    <Group gap="sm" wrap="nowrap" className="eva-wb-avatar" data-testid="widget-avatar">
      <Avatar
        src={spec.src !== undefined ? mediaUrl(spec.src) : null}
        name={spec.name}
        color="initials"
        alt={spec.name}
        radius="100%"
      />
      <div className="eva-wb-avatar-text">
        <Text size="sm" fw={500} truncate>
          {spec.name}
        </Text>
        {spec.subtitle !== undefined ? (
          <Text size="xs" c="dimmed" truncate>
            {spec.subtitle}
          </Text>
        ) : null}
      </div>
    </Group>
  )
}

/** Moments down a hairline; a toned moment fills its bullet in that tone. */
export function TimelineBlock({ spec }: { spec: TimelineSpec }) {
  const color = useToneColor()
  return (
    <Timeline
      active={-1}
      bulletSize={12}
      lineWidth={1}
      className="eva-wb-timeline"
      data-testid="widget-timeline"
    >
      {spec.items.map((item, i) => (
        <Timeline.Item
          key={i}
          title={
            <Group justify="space-between" gap="sm" wrap="nowrap">
              <Text size="sm" fw={500}>
                {item.title}
              </Text>
              {item.time !== undefined ? (
                <Text size="xs" c="dimmed" className="eva-wb-num">
                  {item.time}
                </Text>
              ) : null}
            </Group>
          }
          styles={
            item.tone !== undefined
              ? {
                  itemBullet: {
                    borderColor: `var(--mantine-color-${color(item.tone)}-filled)`,
                    background: `var(--mantine-color-${color(item.tone)}-filled)`,
                  },
                }
              : undefined
          }
          data-tone={item.tone}
        >
          {item.text !== undefined ? (
            <Text size="sm" c="dimmed">
              {item.text}
            </Text>
          ) : null}
        </Timeline.Item>
      ))}
    </Timeline>
  )
}
