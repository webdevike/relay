import { ActionIcon, Alert, Badge, Button, Group, Text, Tooltip } from '@mantine/core'
import { IconDeviceFloppy } from '@tabler/icons-react'
import type * as Y from 'yjs'
import { useYMap } from './use-ymap'

interface SkillDocBarProps {
  /** The live doc's `state` map, written only by the host. */
  state: Y.Map<unknown>
  /** The last save answered `changed-on-disk`. */
  conflict: boolean
  busy: boolean
  onSave: (force: boolean) => void
  onReload: () => void
}

/**
 * The slim row above the editor: the file's name, and only while there are unsaved edits an
 * Unsaved mark with its save button. When SKILL.md moved on disk under unsaved edits, an alert
 * offers to reload it or overwrite it with the edits.
 */
export function SkillDocBar({ state, conflict, busy, onSave, onReload }: SkillDocBarProps) {
  const s = useYMap(state)
  const dirty = s['dirty'] === true
  const error = typeof s['error'] === 'string' && s['error'] !== '' ? s['error'] : null
  return (
    <>
      <Group gap="xs" wrap="nowrap" data-testid="skill-docbar">
        <Text size="sm" fw={500} flex={1}>
          SKILL.md
        </Text>
        {dirty ? (
          <>
            <Badge variant="dot" color="yellow" tt="none" data-testid="skill-unsaved">
              Unsaved
            </Badge>
            <Tooltip label="Save (⌘S)" openDelay={300}>
              <ActionIcon
                variant="default"
                aria-label="Save"
                data-testid="skill-save"
                loading={busy}
                onClick={() => onSave(false)}
              >
                <IconDeviceFloppy size={16} />
              </ActionIcon>
            </Tooltip>
          </>
        ) : null}
      </Group>
      {conflict || s['diskChanged'] === true ? (
        <Alert color="yellow" variant="light" p="xs" data-testid="skill-disk-changed">
          <Group gap="xs" wrap="nowrap">
            <Text size="sm" flex={1}>
              SKILL.md changed on disk.
            </Text>
            <Button size="compact-xs" variant="default" disabled={busy} onClick={onReload}>
              Reload
            </Button>
            <Button size="compact-xs" variant="subtle" disabled={busy} onClick={() => onSave(true)}>
              Overwrite
            </Button>
          </Group>
        </Alert>
      ) : null}
      {error ? (
        <Text size="xs" c="var(--eva-c-danger)">
          {error}
        </Text>
      ) : null}
    </>
  )
}
