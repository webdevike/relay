import { Text, Timeline } from '@mantine/core'
import { useEffect, useState } from 'react'
import { shortBuild, type ChangelogEntry } from '@evaos/contract'
import { formatTime, groupByDay, useAbout } from '../about/build-info'
import { invoke } from '../ipc'

/** One timeline line: a desktop build with the changes it shipped, or a Relay Host install. */
function Entry({ entry, current }: { entry: ChangelogEntry; current: boolean }) {
  const when = formatTime(entry.at)
  if (entry.kind === 'host') {
    return (
      <Timeline.Item title={`Relay Host ${entry.version}`} data-testid="changelog-host">
        <Text size="xs" c="dimmed">
          {when}
        </Text>
      </Timeline.Item>
    )
  }
  return (
    <Timeline.Item
      title={`${shortBuild(entry.build)}${current ? ' · You are here' : ''}`}
      data-testid="changelog-build"
    >
      <Text size="xs" c="dimmed">
        {when}
      </Text>
      {entry.changes.map((c) => (
        <Text key={c} size="sm">
          {c}
        </Text>
      ))}
    </Timeline.Item>
  )
}

/**
 * Every deployed Relay Desktop build and Relay Host install, newest first in day groups, from the
 * deploy history the update source keeps (this copy's own, or the Mini's over ssh on a thin client).
 */
export function ChangelogSection() {
  const about = useAbout()
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null)
  useEffect(() => {
    let cancelled = false
    void invoke('update.changelog', {}).then((r) => {
      if (!cancelled) setEntries(r.ok ? r.value.entries : [])
    })
    return () => {
      cancelled = true
    }
  }, [])
  if (entries === null) return null
  if (entries.length === 0) {
    return (
      <p className="eva-settings-desc" data-testid="changelog-empty">
        No deploy history here. Only an installed Relay with an update source has one.
      </p>
    )
  }
  const mine = shortBuild(about?.build ?? null)
  return (
    <div data-testid="changelog">
      {groupByDay(entries).map((day) => (
        <section key={day.day} className="eva-changelog-day" data-testid="changelog-day">
          <h2 className="eva-changelog-heading">{day.day}</h2>
          <Timeline bulletSize={10} lineWidth={1}>
            {day.entries.map((e) => (
              <Entry
                key={e.kind === 'host' ? `host-${e.version}-${e.at}` : `${e.build}-${e.at}`}
                entry={e}
                current={e.kind === 'desktop' && mine !== null && shortBuild(e.build) === mine}
              />
            ))}
          </Timeline>
        </section>
      ))}
    </div>
  )
}
