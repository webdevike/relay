import { useEffect, type ReactNode } from 'react'
import { UnstyledButton } from '@mantine/core'
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconSparkles,
} from '@tabler/icons-react'
import type { SkillAssistant, SkillRow } from '@evaos/contract'
import { AgentPortrait } from '../assistants/AgentPortrait'
import { ListEmpty, ListPill, ListRow, ListTime, ListView, type ListColumn } from '../ui/list'
import { BRAND_MARKS, ClaudeMark } from './brand-marks'
import type { SkillGroup, TableEntry } from './skill-groups'
import {
  ORIGIN_LABELS,
  originOf,
  sourcePill,
  updatedLabel,
  type SkillOrigin,
  type SkillSort,
  type SkillSortKey,
} from './skills-model'

interface SkillsTableProps {
  entries: readonly TableEntry[]
  /** A group row is open (its members drawn under it). */
  isOpen: (groupId: string) => boolean
  onToggle: (groupId: string) => void
  /** The list has not been read yet. */
  loading: boolean
  assistants: readonly SkillAssistant[]
  sort: SkillSort
  onSort: (key: SkillSortKey) => void
  selected: string | null
  onSelect: (name: string) => void
  now: number
  /** The host counts uses (a host from before usage stats does not): show Uses and Last used. */
  usage: boolean
  /** A skill's panel, which shows its description and folder, is open: no Description or Source. */
  narrow: boolean
  /** Shown instead of rows when there are none (no skills, or none match). */
  empty: ReactNode
}

/** Up and Down from the selected row (or into the list from nothing selected). */
export function neighbor(
  rows: readonly Pick<SkillRow, 'name'>[],
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

/** Origin's cell: omp's name, Claude with its mark, or Both, as quiet as the other columns. */
function OriginCell({ origin }: { origin: SkillOrigin | null }) {
  if (origin === null) return <span />
  const title =
    origin === 'both'
      ? 'Loaded by omp and by Claude Code'
      : origin === 'claude'
        ? 'From Claude Code: ~/.claude/skills or a .claude/skills folder'
        : 'From omp: ~/.omp, .omp or an agents skills folder'
  return (
    <span className="eva-skills-origin" title={title} data-origin={origin}>
      {origin === 'claude' ? <ClaudeMark size={12} /> : null}
      {ORIGIN_LABELS[origin]}
    </span>
  )
}

/**
 * The library on Relay's list (columns mode, as Jobs and Test Bench): name, description, source,
 * origin, who loads it, how often and how lately it was used, and its age (no description, source
 * or origin while a skill's panel, which shows the first two, is open beside it). Skills that
 * came from one place are a group row that opens onto its members; it adds up their uses and
 * newest load. Name, Uses, Last used and Updated sort from their headers (groups by their
 * aggregate, members inside); Up and Down move between rows, and the focused skill row is the
 * selected one. A skill never used says so quietly.
 */
export function SkillsTable({
  entries,
  isOpen,
  onToggle,
  loading,
  assistants,
  sort,
  onSort,
  selected,
  onSelect,
  now,
  usage,
  narrow,
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
      // Wide enough for a member's long name under its group's chevron and indent.
      width: narrow ? 'minmax(120px, 1fr)' : 'minmax(15rem, 1fr)',
    },
    // Fixed widths: every row is its own grid, so an auto track would size to that row's pill or
    // portraits and push the Description column to a different left edge in each row.
    ...(narrow
      ? []
      : [
          {
            id: 'description',
            label: 'Description',
            width: 'minmax(0, 1.6fr)',
            align: 'start' as const,
          },
          { id: 'source', label: 'Source', width: '9rem', align: 'start' as const },
          { id: 'origin', label: 'Origin', width: '5rem', align: 'start' as const },
        ]),
    { id: 'used', label: 'Used by', width: '5rem', align: 'start' },
    ...(usage
      ? [
          {
            id: 'uses',
            label: <SortLabel label="Uses" column="uses" sort={sort} onSort={onSort} />,
            width: '4.5rem',
            align: 'end' as const,
          },
          {
            id: 'last',
            label: <SortLabel label="Last used" column="lastUsed" sort={sort} onSort={onSort} />,
            width: '5.5rem',
            align: 'end' as const,
          },
        ]
      : []),
    {
      id: 'updated',
      label: <SortLabel label="Updated" column="updated" sort={sort} onSort={onSort} />,
      width: '5rem',
      align: 'end',
    },
  ]

  /** Uses, Last used and Updated for a row or a group (a group's are its members' totals). */
  const tail = (
    uses: number | null | undefined,
    lastUsedAt: number | null,
    updatedAt: number,
    testid: string,
  ): ReactNode[] => [
    ...(usage
      ? [
          <span
            key="n"
            className={uses === 0 ? 'eva-skills-num eva-skills-dim' : 'eva-skills-num'}
            data-testid={`skill-uses-${testid}`}
          >
            {uses?.toLocaleString('en-US') ?? ''}
          </span>,
          lastUsedAt === null ? (
            <span key="l" className="eva-skills-dim">
              {uses === 0 ? 'Never' : ''}
            </span>
          ) : (
            <ListTime key="l" title={new Date(lastUsedAt).toLocaleString()}>
              {updatedLabel(lastUsedAt, now)}
            </ListTime>
          ),
        ]
      : []),
    <ListTime key="t" title={new Date(updatedAt).toLocaleString()}>
      {updatedLabel(updatedAt, now)}
    </ListTime>,
  ]

  const groupRow = (g: SkillGroup) => {
    const open = isOpen(g.family.id)
    const Chevron = open ? IconChevronDown : IconChevronRight
    const Mark = g.family.brand === null ? undefined : BRAND_MARKS[g.family.brand]
    const names = g.members.map((m) => m.name).join(', ')
    return (
      <ListRow
        key={g.family.id}
        data-testid={`skill-group-${g.family.id}`}
        aria-expanded={open}
        title={
          <span className="eva-skills-name" data-group="">
            <Chevron className="eva-skills-chev" size={14} stroke={1.5} aria-hidden />
            {Mark ? <Mark size={16} stroke={1.5} /> : null}
            <span className="eva-skills-group-label">{g.family.label}</span>
            <span className="eva-skills-dim" data-testid={`skill-group-count-${g.family.id}`}>
              {g.members.length}
            </span>
          </span>
        }
        tooltip={`${g.family.label}: ${names}`}
        onActivate={() => onToggle(g.family.id)}
        cells={[
          ...(narrow
            ? []
            : [
                <span key="d" className="eva-skills-desc" title={names}>
                  {names}
                </span>,
                <span key="s" />,
                <OriginCell key="o" origin={g.origin} />,
              ]),
          <span key="u" />,
          ...tail(g.uses, g.lastUsedAt, g.updatedAt, g.family.id),
        ]}
      />
    )
  }

  const skillRow = (r: SkillRow, member: boolean) => {
    const users = r.usedBy.flatMap((id) => byId.get(id) ?? [])
    const userNames = users.map((u) => u.title).join(', ')
    return (
      <ListRow
        key={r.name}
        data-skill={r.name}
        data-testid={`skill-row-${r.name}`}
        aria-selected={r.name === selected}
        active={r.name === selected}
        dim={r.disabled}
        title={
          <span className="eva-skills-name" data-member={member || undefined}>
            {r.name}
          </span>
        }
        tooltip={r.name}
        onActivate={() => onSelect(r.name)}
        onFocus={(e) => {
          if (e.target === e.currentTarget && r.name !== selected) onSelect(r.name)
        }}
        cells={[
          ...(narrow
            ? []
            : [
                <span key="d" className="eva-skills-desc" title={r.description}>
                  {r.description}
                </span>,
                <span
                  key="s"
                  className="eva-skills-source"
                  title={[r.source, ...r.also].map((x) => x.dir).join('\n')}
                >
                  <ListPill tone="dim">{sourcePill(r)}</ListPill>
                </span>,
                <OriginCell key="o" origin={originOf(r)} />,
              ]),
          users.length > 0 ? (
            <span
              key="u"
              className="eva-skills-users"
              role="img"
              aria-label={userNames}
              title={userNames}
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
          ...tail(r.uses, r.lastUsedAt, r.updatedAt, r.name),
        ]}
      />
    )
  }

  type Line = { entry: TableEntry } | { member: SkillRow }
  const lines: Line[] = entries.flatMap((entry): Line[] =>
    entry.kind === 'group' && isOpen(entry.family.id)
      ? [{ entry }, ...entry.members.map((member) => ({ member }))]
      : [{ entry }],
  )
  return (
    <ListView<Line>
      data-testid="skills-table"
      columns={columns}
      groups={[{ id: 'skills', items: lines }]}
      rowKey={(l) =>
        'member' in l
          ? `m:${l.member.name}`
          : l.entry.kind === 'group'
            ? l.entry.family.id
            : l.entry.row.name
      }
      empty={empty}
      loading={loading ? { label: 'Loading skills', testid: 'skills-loading' } : false}
      renderRow={(l) =>
        'member' in l
          ? skillRow(l.member, true)
          : l.entry.kind === 'group'
            ? groupRow(l.entry)
            : skillRow(l.entry.row, false)
      }
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
