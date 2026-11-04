import { Button, Group, Stack, Text, TextInput } from '@mantine/core'
import { useEffect, useState } from 'react'
import { placeOf } from '@evaos/shell-core'
import { openPlace } from '../navigation/navigate'
import { EvaModal } from '../overlay'
import { createAgent } from './assistants-store'

/**
 * "New assistant": a name and, optionally, what it is for. Relay Host adds it to the registry and
 * opens its thread on a setup interview (purpose, what it owns, tone, face, voice, model), so the
 * page it opens next is that conversation.
 */
export function NewAssistantModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [scope, setScope] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!opened) return
    setTitle('')
    setScope('')
    setError(null)
  }, [opened])
  return (
    <EvaModal opened={opened} onClose={onClose} title="New assistant" size={440} testid="new-assistant-modal">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!title.trim() || busy) return
          setBusy(true)
          setError(null)
          createAgent(title.trim(), scope.trim())
            .then((id) => {
              onClose()
              openPlace(placeOf(`agent:${id}`))
            })
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => setBusy(false))
        }}
      >
        <Stack gap="sm">
          <TextInput
            label="Name"
            placeholder="Vega"
            data-testid="new-assistant-name"
            data-autofocus
            value={title}
            maxLength={40}
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
          <TextInput
            label="What is it for?"
            description="Optional. It asks you the rest in its first chat."
            placeholder="Driving and the car"
            data-testid="new-assistant-scope"
            value={scope}
            maxLength={200}
            onChange={(e) => setScope(e.currentTarget.value)}
          />
          {error === null ? null : (
            <Text size="sm" className="eva-as-error" data-testid="new-assistant-error">
              {error}
            </Text>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!title.trim()} data-testid="new-assistant-create">
              Create
            </Button>
          </Group>
        </Stack>
      </form>
    </EvaModal>
  )
}
