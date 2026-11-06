import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Button, Kbd, TextInput } from '@mantine/core'
import { IconCheck, IconChevronDown, IconSearch } from '@tabler/icons-react'
import type { Place } from '@evaos/shell-core'
import { isEditable } from '../agent/focus-safety'
import { EvaMenu } from '../overlay'
import { registerReloader } from '../reload/reload'
import { ScrollArea } from '../ui/ScrollArea'
import { ListEmpty } from '../ui/list'
import { SkillPanel } from './SkillPanel'
import { SkillsEmpty, SkillsTable, neighbor } from './SkillsTable'
import { onSkillRequest, takeSkillRequest } from './skill-request'
import {
  ANY,
  DEFAULT_SORT,
  filterSkills,
  nextSort,
  sortSkills,
  sourceLabels,
  type SkillSort,
} from './skills-model'
import { loadSkills, selectSkill, useSkills } from './skills-store'
import './skills.css'

const PANEL_MIN = 340
const PANEL_DEFAULT = 440
/** The table keeps at least this much beside the panel. */
const TABLE_MIN = 420
/** The panel's width, kept while the app runs. */
let panelWidth = PANEL_DEFAULT

function FilterMenu({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  const [opened, setOpened] = useState(false)
  const current = options.find((o) => o.value === value)?.label ?? options[0]?.label
  return (
    <EvaMenu opened={opened} onChange={setOpened} position="bottom-end" width={200}>
      <EvaMenu.Target>
        <Button variant="default" size="xs" rightSection={<IconChevronDown size={14} />}>
          {label}: {current}
        </Button>
      </EvaMenu.Target>
      <EvaMenu.Dropdown>
        {options.map((o) => (
          <EvaMenu.Item
            key={o.value}
            onClick={() => onChange(o.value)}
            rightSection={o.value === value ? <IconCheck size={14} /> : null}
          >
            {o.label}
          </EvaMenu.Item>
        ))}
      </EvaMenu.Dropdown>
    </EvaMenu>
  )
}

/** Skills: every skill the assistants load, a searchable table beside the selected one's panel. */
export function SkillsPage(_: { place: Place }) {
  const list = useSkills((s) => s.list)
  const assistants = useSkills((s) => s.assistants)
  const available = useSkills((s) => s.available)
  const error = useSkills((s) => s.error)
  const selected = useSkills((s) => s.selected)
  const detail = useSkills((s) => (s.selected === null ? null : (s.details[s.selected] ?? null)))
  const [query, setQuery] = useState('')
  const [source, setSource] = useState(ANY)
  const [usedBy, setUsedBy] = useState(ANY)
  const [sort, setSort] = useState<SkillSort>(DEFAULT_SORT)
  const [width, setWidth] = useState(panelWidth)
  const [now, setNow] = useState(Date.now())
  const search = useRef<HTMLInputElement>(null)
  const body = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const off = registerReloader('skills', loadSkills, [])
    void loadSkills()
    const tick = setInterval(() => setNow(Date.now()), 60_000)
    return () => {
      off()
      clearInterval(tick)
    }
  }, [])

  // A `relay://open/skills?skill=<name>` link selects its skill, before or after this mounts.
  useEffect(() => {
    const pending = takeSkillRequest()
    if (pending !== null) selectSkill(pending)
    return onSkillRequest(selectSkill)
  }, [])

  // `/` puts the cursor in the search, unless a text field already has it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      if (isEditable(document.activeElement)) return
      if (!body.current?.isConnected || body.current.offsetParent === null) return
      e.preventDefault()
      search.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const rows = useMemo(
    () => sortSkills(filterSkills(list ?? [], { query, source, usedBy }), sort),
    [list, query, source, usedBy, sort],
  )
  const row = list?.find((r) => r.name === selected) ?? null
  // A host from before usage stats sends no uses: no Uses or Last used column then.
  const usage = (list ?? []).some((r) => r.uses !== undefined)
  const never = (list ?? []).filter((r) => r.uses === 0).length

  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const start = width
    const max = Math.max(PANEL_MIN, (body.current?.clientWidth ?? 1200) - TABLE_MIN)
    const move = (ev: PointerEvent): void => {
      panelWidth = Math.round(Math.min(Math.max(start - (ev.clientX - startX), PANEL_MIN), max))
      setWidth(panelWidth)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const head = (
    <header className="eva-skills-head">
      <h1 className="eva-skills-title" data-page-title>
        Skills
      </h1>
      {available && list ? (
        <span className="eva-skills-dim" data-testid="skills-count">
          {list.length} skills{usage && never > 0 ? `, ${never} never used` : ''}
        </span>
      ) : null}
    </header>
  )

  if (!available) {
    return (
      <div className="eva-skills" ref={body} data-testid="skills-page">
        <section className="eva-skills-main">
          {head}
          <ListEmpty role="status" data-testid="skills-unavailable">
            <span title={error ?? undefined}>Skills needs the Relay host running on this Mac.</span>
          </ListEmpty>
        </section>
      </div>
    )
  }

  return (
    <div className="eva-skills" ref={body} data-testid="skills-page">
      <section className="eva-skills-main">
        {head}
        <div className="eva-skills-tools">
          <TextInput
            ref={search}
            size="xs"
            className="eva-skills-search"
            placeholder="Search name or description"
            aria-label="Search skills"
            leftSection={<IconSearch size={14} />}
            rightSection={query === '' ? <Kbd size="xs">/</Kbd> : null}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query !== '') {
                e.stopPropagation()
                setQuery('')
              } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                const next = neighbor(rows, selected, e.key === 'ArrowDown' ? 1 : -1)
                if (next === null) return
                e.preventDefault()
                selectSkill(next)
              }
            }}
          />
          <FilterMenu
            label="Source"
            value={source}
            options={[
              { value: ANY, label: 'All' },
              ...sourceLabels(list ?? []).map((l) => ({ value: l, label: l })),
            ]}
            onChange={setSource}
          />
          <FilterMenu
            label="Used by"
            value={usedBy}
            options={[
              { value: ANY, label: 'Any' },
              ...assistants.map((a) => ({ value: a.id, label: a.title })),
            ]}
            onChange={setUsedBy}
          />
        </div>
        <ScrollArea scrollKey="skills" className="eva-skills-scroll">
          <SkillsTable
            rows={rows}
            loading={list === null}
            assistants={assistants}
            sort={sort}
            onSort={(key) => setSort((s) => nextSort(s, key))}
            selected={selected}
            onSelect={selectSkill}
            now={now}
            usage={usage}
            narrow={row !== null}
            empty={<SkillsEmpty filtered={(list ?? []).length > 0} />}
          />
        </ScrollArea>
      </section>
      {row ? (
        <div className="eva-skills-side" style={{ width }}>
          <div
            className="eva-skills-sash"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            onPointerDown={onResizeStart}
            onDoubleClick={() => {
              panelWidth = PANEL_DEFAULT
              setWidth(PANEL_DEFAULT)
            }}
          />
          <SkillPanel
            row={row}
            detail={detail}
            assistants={assistants}
            now={now}
            onClose={() => selectSkill(null)}
          />
        </div>
      ) : null}
    </div>
  )
}
