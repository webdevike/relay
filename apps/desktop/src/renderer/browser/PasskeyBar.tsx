import { useEffect, useState } from 'react'
import { ActionIcon, Button } from '@mantine/core'
import { IconKey, IconX } from '@tabler/icons-react'
import type { TabState } from '@evaos/contract'
import { invoke } from '../ipc'

/**
 * Shown when the page asked for a passkey (TabState.passkey). Electron can't reach iCloud
 * Keychain passkeys or a phone, so the bar offers the same page in the macOS default browser.
 */
export function PasskeyBar({ tab }: { tab: TabState }) {
  const [browser, setBrowser] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void invoke('browser.systemBrowser', {}).then((r) => {
      if (live && r.ok) setBrowser(r.value.name)
    })
    return () => {
      live = false
    }
  }, [])
  return (
    <div className="eva-passkey-bar" role="status" data-testid="passkey-bar">
      <IconKey size={16} stroke={1.5} aria-hidden="true" />
      <span className="eva-passkey-bar-text">Passkeys don&apos;t work here.</span>
      <Button
        size="compact-sm"
        variant="default"
        data-testid="passkey-open-external"
        onClick={() => void invoke('browser.openExternal', { tabId: tab.id })}
      >
        {browser ? `Open in ${browser}` : 'Open in your browser'}
      </Button>
      <ActionIcon
        variant="subtle"
        size={24}
        aria-label="Dismiss"
        data-testid="passkey-dismiss"
        onClick={() => void invoke('browser.dismissPasskey', { tabId: tab.id })}
      >
        <IconX size={14} stroke={1.5} />
      </ActionIcon>
    </div>
  )
}
