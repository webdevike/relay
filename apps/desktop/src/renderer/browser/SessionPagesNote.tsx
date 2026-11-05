import { Button, Group, Text } from '@mantine/core'

/** The quiet note a finished session's pages get: close them, or keep them. */
export function SessionPagesNote(props: {
  count: number
  session: string
  onClose: () => void
  onKeep: () => void
}) {
  const pages = props.count === 1 ? '1 page' : `${props.count} pages`
  return (
    <div data-testid="session-pages">
      <Text size="sm">{`Close ${pages} ${props.session} opened?`}</Text>
      <Group gap="xs" mt={6}>
        <Button
          size="compact-xs"
          variant="default"
          data-testid="session-pages-close"
          onClick={props.onClose}
        >
          Close
        </Button>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          data-testid="session-pages-keep"
          onClick={props.onKeep}
        >
          Keep
        </Button>
      </Group>
    </div>
  )
}
