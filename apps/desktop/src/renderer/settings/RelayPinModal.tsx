import { useEffect, useState } from 'react'
import { Button, Group, Text, TextInput } from '@mantine/core'
import { invoke, on } from '../ipc'
import { EvaModal } from '../overlay'

/** Asks for the PIN a remote Relay Host prints in its log the first time this Mac pairs. */
export function RelayPinModal() {
  const [ask, setAsk] = useState<{ id: string; retry: boolean } | null>(null)
  const [pin, setPin] = useState('')

  useEffect(
    () =>
      on('relay.pin.request', (req) => {
        setPin('')
        setAsk(req)
      }),
    [],
  )

  const answer = (value: string | null): void => {
    if (!ask) return
    void invoke('relay.pin.reply', { id: ask.id, pin: value }).catch(() => {})
    setAsk(null)
  }

  return (
    <EvaModal
      opened={ask !== null}
      onClose={() => answer(null)}
      title="Pair with Relay Host"
      size={380}
      testid="relay-pin"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (/^\d{6}$/.test(pin)) answer(pin)
        }}
      >
        <Text size="sm" mb="sm">
          {ask?.retry ? 'That PIN was wrong. ' : ''}Enter the 6-digit PIN shown in the Relay Host
          log on the Mac Mini.
        </Text>
        <TextInput
          aria-label="PIN"
          data-autofocus
          inputMode="numeric"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))}
          data-testid="relay-pin-input"
        />
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => answer(null)}>
            Cancel
          </Button>
          <Button type="submit" disabled={!/^\d{6}$/.test(pin)}>
            Pair
          </Button>
        </Group>
      </form>
    </EvaModal>
  )
}
