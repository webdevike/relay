import { useContext, useState } from 'react'
import { Button, Group, Stack, Text, Textarea, TextInput } from '@mantine/core'
import { IconCheck } from '@tabler/icons-react'
import type { ButtonSpec, InputSpec } from '@evaos/chat-core/widget'
import { openLink } from '../../../navigation/open-link'
import { OpenUIActions, useWidgetActions } from '../actions'
import { useToneColor } from '../rich/parts'
import { WidgetCell } from './cell'
import { useToneText } from './content'

const VARIANT: Record<ButtonSpec['variant'], string> = {
  primary: 'filled',
  secondary: 'default',
  subtle: 'subtle',
}

/** `url` opens the page in the side browser; `reply` sends its text as Isaac's next turn; `action`
 * runs the OpenUI block's action, then sends or opens what it hands back. In a grid cell or a
 * horizontal stack's column the button fills it; grid keys are taller, with a larger label. */
export function ButtonBlock({ spec }: { spec: ButtonSpec }) {
  const { reply, canReply } = useWidgetActions()
  const openui = useContext(OpenUIActions)
  const cell = useContext(WidgetCell)
  const color = useToneColor()
  const toneText = useToneText()
  const replyText = spec.reply
  const variant = VARIANT[spec.variant]
  const send = (text: string | undefined, url: string | undefined): void => {
    if (text !== undefined && canReply) reply(text)
    if (url !== undefined) openLink(url)
  }
  return (
    <Button
      size={cell === 'grid' ? 'md' : 'xs'}
      h={cell === 'grid' ? 40 : undefined}
      fullWidth={cell !== null}
      variant={variant}
      color={spec.tone !== undefined ? color(spec.tone) : undefined}
      // The neutral variant ignores `color`; a tone tints its label instead.
      c={variant === 'default' ? toneText(spec.tone) : undefined}
      className="eva-wb-button"
      data-testid="widget-button"
      data-cell={cell ?? undefined}
      disabled={(replyText !== undefined && !canReply) || (spec.action !== undefined && !openui)}
      onClick={() => {
        if (spec.action === undefined) send(replyText, spec.url)
        else if (openui) {
          const out = openui.dispatch(spec.action)
          send(out.reply, out.url)
        }
      }}
    >
      {spec.label}
    </Button>
  )
}

/** A field whose submit sends `reply` with `{value}` replaced by the typed text, then says Sent.
 * With a `bind` id (OpenUI) the field shows `value` and each edit writes the block's `$variable`,
 * so it works without a session and keeps its text after sending. */
export function InputBlock({ spec }: { spec: InputSpec }) {
  const { reply, canReply } = useWidgetActions()
  const openui = useContext(OpenUIActions)
  const [local, setLocal] = useState('')
  const [sent, setSent] = useState(false)
  const { bind } = spec
  const bound = bind !== undefined && openui !== null
  const value = bound ? (spec.value ?? '') : local
  const setValue = (text: string): void => {
    if (bind !== undefined && openui !== null) openui.setInput(bind, text)
    else setLocal(text)
  }
  const typed = value.trim()
  const submit = (): void => {
    if (!canReply || typed === '') return
    reply(spec.reply.replaceAll('{value}', typed))
    if (!bound) setLocal('')
    setSent(true)
  }
  const field = {
    value,
    placeholder: spec.placeholder,
    disabled: !canReply && !bound,
    size: 'sm',
    className: 'eva-wb-input-field',
    'aria-label': spec.placeholder ?? 'Reply',
  } as const
  return (
    <Stack gap={4} className="eva-wb-input" data-testid="widget-input">
      <Group gap={6} wrap="nowrap" align="flex-end">
        {spec.multiline ? (
          <Textarea
            {...field}
            autosize
            minRows={2}
            maxRows={6}
            onChange={(e) => setValue(e.currentTarget.value)}
          />
        ) : (
          <TextInput
            {...field}
            onChange={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
        )}
        <Button size="sm" disabled={!canReply || typed === ''} onClick={submit}>
          {spec.button}
        </Button>
      </Group>
      {sent ? (
        <Group gap={4} className="eva-wb-sent" data-testid="widget-input-sent">
          <IconCheck size={12} stroke={2} />
          <Text size="xs" c="dimmed" span>
            Sent
          </Text>
        </Group>
      ) : null}
    </Stack>
  )
}
