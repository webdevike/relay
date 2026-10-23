import { useState } from 'react'
import { Button, Group, Stack, Text, Textarea, TextInput } from '@mantine/core'
import { IconCheck } from '@tabler/icons-react'
import type { ButtonSpec, InputSpec } from '@evaos/chat-core/widget'
import { openLink } from '../../../navigation/open-link'
import { useWidgetActions } from '../actions'
import { useToneColor } from '../rich/parts'
import { useToneText } from './content'

const VARIANT: Record<ButtonSpec['variant'], string> = {
  primary: 'filled',
  secondary: 'default',
  subtle: 'subtle',
}

/** `url` opens the page in the side browser; `reply` sends its text as Isaac's next turn. */
export function ButtonBlock({ spec }: { spec: ButtonSpec }) {
  const { reply, canReply } = useWidgetActions()
  const color = useToneColor()
  const toneText = useToneText()
  const replyText = spec.reply
  const variant = VARIANT[spec.variant]
  return (
    <Button
      size="xs"
      variant={variant}
      color={spec.tone !== undefined ? color(spec.tone) : undefined}
      // The neutral variant ignores `color`; a tone tints its label instead.
      c={variant === 'default' ? toneText(spec.tone) : undefined}
      className="eva-wb-button"
      data-testid="widget-button"
      disabled={replyText !== undefined && !canReply}
      onClick={() => {
        if (replyText !== undefined) reply(replyText)
        else if (spec.url !== undefined) openLink(spec.url)
      }}
    >
      {spec.label}
    </Button>
  )
}

/** A field whose submit sends `reply` with `{value}` replaced by the typed text, then says Sent. */
export function InputBlock({ spec }: { spec: InputSpec }) {
  const { reply, canReply } = useWidgetActions()
  const [value, setValue] = useState('')
  const [sent, setSent] = useState(false)
  const typed = value.trim()
  const submit = (): void => {
    if (!canReply || typed === '') return
    reply(spec.reply.replaceAll('{value}', typed))
    setValue('')
    setSent(true)
  }
  const field = {
    value,
    placeholder: spec.placeholder,
    disabled: !canReply,
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
