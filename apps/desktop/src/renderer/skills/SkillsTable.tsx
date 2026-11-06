import { useEffect, type ReactNode } from 'react'
import { UnstyledButton } from '@mantine/core'
import { IconArrowDown, IconArrowUp, IconSparkles } from '@tabler/icons-react'
import type { SkillAssistant, SkillRow } from '@evaos/contract'
import { AgentPortrait } from '../assistants/AgentPortrait'
import { ListEmpty, ListPill, ListRow, ListTime, ListView, type ListColumn } from '../ui/list'
import { sourcePill, updatedLabel, type SkillSort, type SkillSortKey } from './skills-model'

interface SkillsTableProps {
  rows: readonly SkillRow[]
  /** The list has not been read yet. */
  loading: boolean
  assistants: readonly SkillAssistant[]
  sort: SkillSort
  onSort: (key: SkillSortKey) => void
  selected: string | null
  onSelect: (name: string) => void
  now: number
  /** Shown instead of rows when there are none (no skills, or none match). */
  empty: ReactNode
}

/** Up and Down from the selected row (or into the list from nothing selected). */
export function neighbor(
  rows: readonly SkillRow[],
  selected: string | null,
  step: 1 | -1,
): string | null {
  if (rows.length === 0) return null
  const at = rows.findIndex((r) => r.name === selected)
  if (at === -1) return rows[step === 1 ? 0 : rows.length - 1]!.name
  return rows[Math.min(Math.max(at + step, 0), rows.length - 1)]!.name
}

function SortLabel({
  label,
  column,
  sort,
  onSort,
}: {
  label: string
  column: SkillSortKey
  sort: SkillSort
  onSort: (key: SkillSortKey) => void
}) {
  const on = sort.key === column
  const Arrow = sort.dir === 'asc' ? IconArrowUp : IconArrowDown
  return (
    <UnstyledButton
      className="eva-skills-sort"
      aria-label={`Sort by ${label.toLowerCase()}`}
      onClick={() => onSort(column)}
    >
      {label}
      {on ? <Arrow size={12} stroke={1.5} aria-hidden /> : null}
    </UnstyledButton>
  )
}

/**
 * The library on Relay's list (columns mode, as Jobs and Test Bench): name, description, source,
 * who loads it and its age. Name and Updated sort from their headers; Up and Down move between
 * rows, and the focused row is the selected one.
 */
export function SkillsTable({
  rows,
  loading,
  assistants,
  sort,
  onSort,
  selected,
  onSelect,
  now,
  empty,
}: SkillsTableProps) {
  const byId = new Map(assistants.map((a) => [a.id, a]))
  // A selection from elsewhere (the search's arrow keys, a link) brings its row into view.
  useEffect(() => {
    if (selected === null) return
    document
      .querySelector(`[data-testid="skills-table"] [data-skill="${CSS.escape(selected)}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])
  const columns: ListColumn[] = [
    {
      id: 'name',
      label: <SortLabel label="Name" column="name" sort={sort} onSort={onSort} />,
      width: 'minmax(120px, 1fr)',
    },
    { id: 'description', label: 'Description', width: 'minmax(0, 1.6fr)', align: 'start' },
    // Fixed widths: every row is its own grid, so an auto track would size to that row's pill or
    // portraits and push the Description column to a different left edge in each row.
    { id: 'source', label: 'Source', width: '9rem', align: 'start' },
    { id: 'used', label: 'Used by', width: '5rem', align: 'start' },
    {
      id: 'updated',
      label: <SortLabel label="Updated" column="updated" sort={sort} onSort={onSort} />,
      width: '5rem',
      align: 'end',
    },
  ]
  return (
    <ListView<SkillRow>
      data-testid="skills-table"
      columns={columns}
      groups={[{ id: 'skills', items: rows }]}
      rowKey={(r) => r.name}
      empty={empty}
      loading={loading ? { label: 'Loading skills', testid: 'skills-loading' } : false}
      renderRow={(r) => {
        const users = r.usedBy.flatMap((id) => byId.get(id) ?? [])
        const names = users.map((u) => u.title).join(', ')
        return (
          <ListRow
            key={r.name}
            data-skill={r.name}
            data-testid={`skill-row-${r.name}`}
            aria-selected={r.name === selected}
            active={r.name === selected}
            dim={r.disabled}
            title={r.name}
            onActivate={() => onSelect(r.name)}
            onFocus={(e) => {
              if (e.target === e.currentTarget && r.name !== selected) onSelect(r.name)
            }}
            cells={[
              <span key="d" className="eva-skills-desc" title={r.description}>
                {r.description}
              </span>,
              <span
                key="s"
                className="eva-skills-source"
                title={[r.source, ...r.also].map((s) => s.dir).join('\n')}
              >
                <ListPill tone="dim">{sourcePill(r)}</ListPill>
              </span>,
              users.length > 0 ? (
                <span
                  key="u"
                  className="eva-skills-users"
                  role="img"
                  aria-label={names}
                  title={names}
                >
                  {users.map((u) => (
                    <AgentPortrait key={u.id} id={u.id} className="eva-skills-portrait" />
                  ))}
                </span>
              ) : (
                <span key="u" className="eva-skills-dim">
                  {r.disabled ? 'Off' : 'None'}
                </span>
              ),
              <ListTime key="t" title={new Date(r.updatedAt).toLocaleString()}>
                {updatedLabel(r.updatedAt, now)}
              </ListTime>,
            ]}
          />
        )
      }}
    />
  )
}

/** The library's empty states, Relay's ListEmpty. */
export function SkillsEmpty({ filtered }: { filtered: boolean }) {
  return filtered ? (
    <ListEmpty data-testid="skills-no-match">No skills match.</ListEmpty>
  ) : (
    <ListEmpty
      data-testid="skills-empty"
      icon={<IconSparkles size={24} stroke={1.5} />}
      title="No skills yet"
    >
      A skill is a folder with a SKILL.md in an omp skills directory.
    </ListEmpty>
  )
}
