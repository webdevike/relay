import { Badge, Button, Group, PasswordInput, Text } from '@mantine/core'
import { useEffect, useState } from 'react'
import { LinearKeySchema, type Connection } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { openPlace } from '../navigation/navigate'
import { openLink } from '../navigation/open-link'
import { connect, disconnect, startConnections, useConnections } from './connections-store'

const STATUS: Record<Connection['status'], { label: string; color: string }> = {
  connected: { label: 'Connected', color: 'green' },
  'not-connected': { label: 'Not connected', color: 'gray' },
  unknown: { label: 'Not checked', color: 'yellow' },
}

/** Linear: paste a personal API key; it is saved in Relay's config and never shown again. */
function LinearKeyForm() {
  const [key, setKey] = useState('')
  const busy = useConnections((s) => s.busy === 'linear')
  const valid = LinearKeySchema.safeParse(key).success
  return (
    <form
      className="eva-conn-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) void connect('linear', key.trim()).then((ok) => ok && setKey(''))
      }}
    >
      <PasswordInput
        size="xs"
        aria-label="Linear API key"
        placeholder="lin_api_..."
        data-testid="connection-linear-key"
        value={key}
        autoComplete="off"
        onChange={(e) => setKey(e.currentTarget.value)}
      />
      <Button
        size="xs"
        type="submit"
        disabled={!valid}
        loading={busy}
        data-testid="connection-linear-save"
      >
        Save key
      </Button>
      <Button
        size="xs"
        variant="subtle"
        onClick={() => openLink('https://linear.app/settings/account/security')}
      >
        Create a key
      </Button>
    </form>
  )
}

/** What Connect does for a row that is not connected, or nothing when Settings can't do it. */
function ConnectAction({ row }: { row: Connection }) {
  const busy = useConnections((s) => s.busy === row.id)
  if (row.id === 'linear') return <LinearKeyForm />
  if (row.id === 'relay-host') {
    return (
      <Button size="xs" variant="default" onClick={() => openPlace(placeOf('setup'))}>
        Run setup
      </Button>
    )
  }
  if (row.id === 'slack') {
    return (
      <Button
        size="xs"
        variant="default"
        onClick={() => openLink('https://claude.ai/settings/connectors')}
      >
        Open Claude connectors
      </Button>
    )
  }
  return (
    <Button
      size="xs"
      loading={busy}
      data-testid={`connection-${row.id}-connect`}
      onClick={() => void connect(row.id)}
    >
      {row.id === 'github' ? 'Connect' : 'Sign in'}
    </Button>
  )
}

function DisconnectButton({ row }: { row: Connection }) {
  const [sure, setSure] = useState(false)
  const busy = useConnections((s) => s.busy === row.id)
  return (
    <Button
      size="xs"
      variant={sure ? 'filled' : 'default'}
      color={sure ? 'red' : undefined}
      loading={busy}
      data-testid={`connection-${row.id}-disconnect`}
      onBlur={() => setSure(false)}
      onClick={() => {
        if (!sure) setSure(true)
        else void disconnect(row.id)
      }}
    >
      {sure ? 'Confirm disconnect' : 'Disconnect'}
    </Button>
  )
}

function ConnectionRow({ row }: { row: Connection }) {
  const focused = useConnections((s) => s.focus === row.id)
  const note = useConnections((s) => s.notes[row.id])
  const status = STATUS[row.status]
  const showConnect = row.canAdd && (row.status !== 'connected' || focused || row.id === 'linear')
  return (
    <div
      className="eva-settings-row eva-settings-row-static eva-conn-row"
      data-testid={`connection-${row.id}`}
      data-tour={`connection-${row.id}`}
      data-status={row.status}
      data-focused={focused ? 'true' : undefined}
    >
      <span className="eva-settings-label">
        <Group gap="xs" wrap="nowrap">
          <span className="eva-settings-label-title">{row.title}</span>
          <Badge size="xs" variant="light" color={status.color}>
            {status.label}
          </Badge>
        </Group>
        <span className="eva-settings-label-help">
          {row.account ? `${row.account} · ` : ''}
          {row.detail}
        </span>
        <Text size="xs" c="dimmed">
          Used by {row.usedBy}
        </Text>
        {note ? (
          <Text size="sm" data-testid={`connection-${row.id}-note`}>
            {note}
          </Text>
        ) : null}
      </span>
      <Group gap="xs" wrap="nowrap" className="eva-conn-actions">
        {showConnect ? <ConnectAction row={row} /> : null}
        {row.canRemove ? <DisconnectButton row={row} /> : null}
      </Group>
    </div>
  )
}

/** Settings > Connections: what Relay reads from, with Connect and Disconnect where it can. */
export function ConnectionsSection() {
  useEffect(() => startConnections(), [])
  const rows = useConnections((s) => s.rows)
  const error = useConnections((s) => s.error)
  if (error) {
    return (
      <Text c="red" size="sm" role="alert">
        Could not read connections: {error}
      </Text>
    )
  }
  if (rows === null) return <Text size="sm">Checking connections...</Text>
  return (
    <div className="eva-settings-card" data-testid="connections-list">
      {rows.map((row) => (
        <ConnectionRow key={row.id} row={row} />
      ))}
    </div>
  )
}
