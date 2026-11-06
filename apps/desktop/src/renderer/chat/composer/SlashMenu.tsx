import { Fragment, useEffect, useRef, type ReactNode } from 'react'
import { IconChevronRight } from '@tabler/icons-react'
import { Paper, ScrollArea, Stack, Text, UnstyledButton } from '@mantine/core'

/** One row of the composer's floating menu. `section` heads the run of rows that share it. */
export interface MenuRow {
  key: string
  title: string
  description: string
  icon?: ReactNode
  section?: string
  /** Argument hint shown in the footer while the row is highlighted. */
  hint?: string | null
  /** Has a sub-list: shows a chevron, and Right arrow, Enter or a click opens it. */
  chevron?: boolean
}

/**
 * The composer's floating menu above the box, for `/` commands (like omp's, native chat_view.rs
 * slash_menu) and for `@` (Computer and skills, in sections): each row shows an icon, the title and
 * a grey description; the footer shows the highlighted row's argument hint and the keys. The
 * composer owns the text, the selection and the keys.
 */
export function SlashMenu({
  rows,
  selected,
  onPick,
  label = 'Commands',
  testid = 'slash-menu',
}: {
  rows: readonly MenuRow[]
  selected: number
  onPick: (index: number) => void
  label?: string
  testid?: string
}) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  const hint = rows[selected]?.hint
  return (
    <Paper
      withBorder
      radius="md"
      shadow="sm"
      className="eva-slash-menu"
      data-testid={testid}
      // Clicks must not blur the composer.
      onMouseDown={(e) => e.preventDefault()}
    >
      <ScrollArea.Autosize mah={320} viewportRef={list} type="scroll">
        <Stack gap={2} p={4} role="listbox" aria-label={label}>
          {rows.map((r, i) => (
            <Fragment key={r.key}>
              {r.section !== undefined && r.section !== rows[i - 1]?.section ? (
                <Text
                  size="xs"
                  c="dimmed"
                  px="sm"
                  pt={i === 0 ? 2 : 6}
                  className="eva-slash-section"
                >
                  {r.section}
                </Text>
              ) : null}
              <UnstyledButton
                role="option"
                aria-selected={i === selected}
                data-index={i}
                data-key={r.key}
                className="eva-slash-row"
                onClick={() => onPick(i)}
              >
                {r.icon ? <span className="eva-slash-icon">{r.icon}</span> : null}
                <Text size="sm" fw={600} component="span">
                  {r.title}
                </Text>
                {r.description ? (
                  <Text size="xs" c="dimmed" truncate component="span" className="eva-slash-desc">
                    {r.description}
                  </Text>
                ) : null}
                {r.chevron ? (
                  <IconChevronRight size={14} className="eva-slash-chevron" aria-hidden />
                ) : null}
              </UnstyledButton>
            </Fragment>
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
