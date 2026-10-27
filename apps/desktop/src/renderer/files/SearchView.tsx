import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import { IconChevronRight, IconLetterCase, IconLetterW, IconRegex } from '@tabler/icons-react'
import type { SearchMatch } from '@evaos/contract'
import { FileIcon } from './FileIcon'
import { openFile, runSearch, setSearch, useSpace, type SearchOptions } from './files-store'
import { nameOf, parentOf } from './tree-model'

const TOGGLES: Array<{
  key: keyof Omit<SearchOptions, 'query'>
  label: string
  Icon: typeof IconRegex
}> = [
  { key: 'caseSensitive', label: 'Match case', Icon: IconLetterCase },
  { key: 'wholeWord', label: 'Match whole word', Icon: IconLetterW },
  { key: 'regex', label: 'Use regular expression', Icon: IconRegex },
]

/** A narrow sidebar keeps the match in view: at most a few words of the line before it. */
const LEAD = 16

function Preview({ m }: { m: SearchMatch }) {
  const full = m.preview.slice(0, m.previewStart).trimStart()
  const before = full.length > LEAD ? `…${full.slice(-LEAD)}` : full
  const hit = m.preview.slice(m.previewStart, m.previewStart + m.length)
  const after = m.preview.slice(m.previewStart + m.length)
  return (
    <span className="eva-files-search-preview">
      {before}
      <mark>{hit}</mark>
      {after}
    </span>
  )
}

/** Cmd+Shift+F: search the root's files (ripgrep, else git grep, else a scan). */
export function SearchView({ root, focusKey }: { root: string; focusKey: number }) {
  const search = useSpace((w) => w.search, null)
  const input = useRef<HTMLInputElement>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusKey])

  const query = search?.query ?? ''
  const regex = search?.regex ?? false
  const caseSensitive = search?.caseSensitive ?? false
  const wholeWord = search?.wholeWord ?? false
  useEffect(() => {
    const t = window.setTimeout(() => void runSearch(root), 250)
    return () => window.clearTimeout(t)
  }, [root, query, regex, caseSensitive, wholeWord])

  if (!search) return null
  const result = search.result
  const total = result?.results.reduce((n, f) => n + f.matches.length, 0) ?? 0

  return (
    <div className="eva-files-search" data-testid="files-search">
      <div className="eva-files-search-box">
        <input
          ref={input}
          value={search.query}
          placeholder="Search in files"
          aria-label="Search in files"
          spellCheck={false}
          onChange={(e) => setSearch(root, { query: e.currentTarget.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch(root)
          }}
        />
        {TOGGLES.map(({ key, label, Icon }) => (
          <Tooltip key={key} label={label} openDelay={400}>
            <ActionIcon
              size="sm"
              variant={search[key] ? 'light' : 'subtle'}
              color={search[key] ? undefined : 'gray'}
              aria-label={label}
              aria-pressed={search[key]}
              onClick={() => setSearch(root, { [key]: !search[key] })}
            >
              <Icon size={14} stroke={1.75} />
            </ActionIcon>
          </Tooltip>
        ))}
      </div>
      <div className="eva-files-search-summary">
        {search.error
          ? search.error
          : search.running && !result
            ? 'Searching'
            : result && search.query
              ? `${total} ${total === 1 ? 'result' : 'results'} in ${result.results.length} ${
                  result.results.length === 1 ? 'file' : 'files'
                }${result.truncated ? ', first matches only' : ''}`
              : null}
      </div>
      <div className="eva-files-search-results" role="tree" aria-label="Search results">
        {result?.results.map((f) => {
          const shut = collapsed.has(f.path)
          return (
            <div key={f.path} className="eva-files-search-file">
              <div
                role="treeitem"
                aria-expanded={!shut}
                className="eva-files-search-head"
                title={f.path}
                onClick={() =>
                  setCollapsed((c) => {
                    const next = new Set(c)
                    if (shut) next.delete(f.path)
                    else next.add(f.path)
                    return next
                  })
                }
              >
                <span className="eva-files-twist" data-open={!shut || undefined}>
                  <IconChevronRight size={14} stroke={1.75} />
                </span>
                <FileIcon name={nameOf(f.path)} kind="file" />
                <span className="eva-files-name">{nameOf(f.path)}</span>
                <span className="eva-files-search-dir">{parentOf(f.path)}</span>
                <span className="eva-files-search-count">{f.matches.length}</span>
              </div>
              {shut
                ? null
                : f.matches.map((m) => (
                    <div
                      key={`${m.line}:${m.column}`}
                      role="treeitem"
                      className="eva-files-search-hit"
                      data-testid="search-hit"
                      onClick={() =>
                        openFile(root, f.path, {
                          pin: true,
                          line: m.line,
                          column: m.column,
                          length: m.length,
                        })
                      }
                    >
                      <Preview m={m} />
                    </div>
                  ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
