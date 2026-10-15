import { render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { describe, expect, it } from 'vitest'
import source from './ActivityChart.tsx?raw'
import { ActivityChart, type ActivityRow } from './ActivityChart'

const counts = [0, 1, 0, 2, 0, 0, 3]
const rows: ActivityRow[] = counts.map((count, i) => ({
  date: `2026-10-${String(9 + i).padStart(2, '0')}`,
  tick: `Oct ${9 + i}`,
  count,
  inWeek: i >= 3,
  isToday: i === 6,
}))

function setup(r = rows) {
  return render(
    <MantineProvider>
      <ActivityChart
        rows={r}
        name="Flo"
        rangeLabel="7 days"
        height={160}
        width={600}
        testid="chart"
      />
    </MantineProvider>,
  )
}

describe('ActivityChart', () => {
  it('draws the hatch pattern and a reference area filled with it', () => {
    const { container } = setup()
    expect(container.querySelector('pattern#eva-hatch')).not.toBeNull()
    const area = container.querySelector('.recharts-reference-area-rect')
    expect(area?.getAttribute('fill')).toBe('url(#eva-hatch)')
  })

  it('renders 7 bars and one line, today accented', () => {
    const { container } = setup()
    const bars = container.querySelectorAll('.recharts-bar-rectangle')
    expect(bars.length).toBe(7)
    expect(container.querySelectorAll('.recharts-line-curve').length).toBe(1)
    const fills = Array.from(container.querySelectorAll('.recharts-bar-rectangle path')).map((p) =>
      p.getAttribute('fill'),
    )
    const accent = fills.filter((f) => f === 'var(--eva-c-primary-background)')
    expect(accent.length).toBe(1)
    expect(fills[0]).toContain('--eva-c-muted-foreground')
  })

  it('has an accessible label and hidden table', () => {
    setup()
    expect(
      screen.getByRole('img', { name: 'Activity for Flo: 6 updates in 7 days' }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('row').length).toBe(8)
  })

  it('shows the empty label for all-zero rows', () => {
    setup(rows.map((r) => ({ ...r, count: 0 })))
    expect(screen.getByText('No activity in this range')).toBeInTheDocument()
  })

  it('uses no raw hex colors', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{6}\b/)
  })
})
