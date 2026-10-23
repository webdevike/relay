import { useState, type ReactNode } from 'react'
import { Collapse, Paper, SimpleGrid, Stack, Tabs, UnstyledButton } from '@mantine/core'
import { IconChevronRight } from '@tabler/icons-react'
import type {
  CardSpec,
  CollapseSpec,
  Gap,
  GridSpec,
  StackSpec,
  TabsSpec,
  WidgetKind,
} from '@evaos/chat-core/widget'
import { WidgetTitle } from '../rich/parts'
import { WidgetNode } from '../Widget'

/** widgets.rs gap_px: xs 6, sm 10 (the default), md 16, lg 24. */
const GAP_PX: Record<Gap, number> = { xs: 6, sm: 10, md: 16, lg: 24 }

/** In a row, these keep their own width; everything else shares the row equally. */
const INLINE: Partial<Record<WidgetKind, true>> = { badge: true, button: true, link: true }

/** The one hairline surface a widget sits in: a root card, a nested card (`card`), or a compact
 * root. */
export function Frame({ children, card = false }: { children: ReactNode; card?: boolean }) {
  return (
    <Paper
      withBorder
      p="md"
      className="eva-wb-frame"
      data-testid="widget-frame"
      data-card={card || undefined}
    >
      <Stack gap={GAP_PX.sm}>{children}</Stack>
    </Paper>
  )
}

export function StackBlock({ spec }: { spec: StackSpec }) {
  const gap = GAP_PX[spec.gap ?? 'sm']
  if (spec.direction !== 'horizontal') {
    return (
      <Stack gap={gap} className="eva-wb-stack" data-testid="widget-stack">
        {spec.children.map((child, i) => (
          <WidgetNode key={i} spec={child} />
        ))}
      </Stack>
    )
  }
  return (
    <div className="eva-wb-row" data-testid="widget-stack" style={{ gap }}>
      {spec.children.map((child, i) =>
        INLINE[child.widget] ? (
          <WidgetNode key={i} spec={child} />
        ) : (
          <div key={i} className="eva-wb-row-cell">
            <WidgetNode spec={child} />
          </div>
        ),
      )}
    </div>
  )
}

/** A card: optional title over its children. At the root it is the frame; nested, it draws its
 * own hairline border. */
export function CardBlock({ spec }: { spec: CardSpec }) {
  return (
    <Frame card>
      {spec.title !== undefined ? <WidgetTitle>{spec.title}</WidgetTitle> : null}
      {spec.children.map((child, i) => (
        <WidgetNode key={i} spec={child} />
      ))}
    </Frame>
  )
}

export function GridBlock({ spec }: { spec: GridSpec }) {
  return (
    <SimpleGrid
      cols={spec.columns}
      spacing={GAP_PX[spec.gap ?? 'sm']}
      className="eva-wb-grid"
      data-testid="widget-grid"
    >
      {spec.children.map((child, i) => (
        <div key={i} className="eva-wb-grid-cell">
          <WidgetNode spec={child} />
        </div>
      ))}
    </SimpleGrid>
  )
}

/** Tabs over one pane of children at a time, the first showing to start. */
export function TabsBlock({ spec }: { spec: TabsSpec }) {
  return (
    <Tabs defaultValue="0" className="eva-wb-tabs" data-testid="widget-tabs" keepMounted={false}>
      <Tabs.List>
        {spec.tabs.map((tab, i) => (
          <Tabs.Tab key={i} value={String(i)}>
            {tab.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {spec.tabs.map((tab, i) => (
        <Tabs.Panel key={i} value={String(i)} pt={GAP_PX.sm}>
          <Stack gap={GAP_PX.sm}>
            {tab.children.map((child, j) => (
              <WidgetNode key={j} spec={child} />
            ))}
          </Stack>
        </Tabs.Panel>
      ))}
    </Tabs>
  )
}

/** A header row (chevron and title) that shows or hides its children; `open` sets the start. */
export function CollapseBlock({ spec }: { spec: CollapseSpec }) {
  const [open, setOpen] = useState(spec.open)
  return (
    <div className="eva-wb-collapse" data-testid="widget-collapse">
      <UnstyledButton
        className="eva-wb-collapse-head"
        aria-expanded={open}
        data-open={open}
        onClick={() => setOpen((o) => !o)}
      >
        <IconChevronRight className="eva-wb-chevron" size={14} stroke={1.75} />
        <span>{spec.title}</span>
      </UnstyledButton>
      <Collapse expanded={open}>
        <Stack gap={GAP_PX.sm} pt={GAP_PX.sm}>
          {spec.children.map((child, i) => (
            <WidgetNode key={i} spec={child} />
          ))}
        </Stack>
      </Collapse>
    </div>
  )
}
