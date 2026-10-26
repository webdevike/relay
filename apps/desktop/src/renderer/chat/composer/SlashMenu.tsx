import { useEffect, useRef } from 'react'
import { Paper, ScrollArea, Stack, Text, UnstyledButton } from '@mantine/core'
import type { SlashCommand } from '@evaos/chat-core/launch'

/**
 * The composer's `/` menu, floating above it like omp's (native chat_view.rs slash_menu): each
 * row shows the full command and its description; the footer shows the highlighted row's
 * argument hint and the keys. The composer owns the text, the selection and the keys.
 */
export function SlashMenu({
  prefix,
  hits,
  selected,
  onPick,
}: {
  prefix: string
  hits: readonly SlashCommand[]
  selected: number
  onPick: (index: number) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  const hint = hits[selected]?.hint
  return (
    <Paper
      withBorder
      radius="md"
      shadow="sm"
      className="eva-slash-menu"
      data-testid="slash-menu"
      // Clicks must not blur the composer.
      onMouseDown={(e) => e.preventDefault()}
    >
      <ScrollArea.Autosize mah={320} viewportRef={list} type="scroll">
        <Stack gap={2} p={4} role="listbox" aria-label="Commands">
          {hits.map((c, i) => (
            <UnstyledButton
              key={c.name}
              role="option"
              aria-selected={i === selected}
              data-index={i}
              className="eva-slash-row"
              onClick={() => onPick(i)}
            >
              <Text size="sm" fw={600}>
                {prefix}
                {c.name}
              </Text>
              {c.description ? (
                <Text size="xs" c="dimmed" truncate>
                  {c.description}
                </Text>
              ) : null}
            </UnstyledButton>
          ))}
        </Stack>
      </ScrollArea.Autosize>
      <Stack gap={2} px="sm" py={6} className="eva-slash-footer">
        {hint ? (
          <Text size="xs" c="dimmed" truncate>
            {hint}
          </Text>
        ) : null}
        <Text size="xs" c="dimmed">
          Tab / Enter to select · Up / Down to navigate · Esc to close
        </Text>
      </Stack>
    </Paper>
  )
}
