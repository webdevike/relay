import { useEffect, useState } from 'react'
import { Button, Switch } from '@mantine/core'
import { useAssistants } from '../assistants/assistants-store'
import {
  saveNotificationPrefs,
  sendTestNotification,
  startNotificationPrefs,
  useNotificationPrefs,
} from '../notifications/notifications-store'

/**
 * Settings > Notifications: the global switch, one switch per assistant (off mutes its replies,
 * questions and canvases), and Send test. The rules are in main/notifications/policy.ts: this Mac
 * speaks only while you are at it (input in the last 10 minutes) and the chat is not in front;
 * away from it, the phone gets the notification.
 */
export function NotificationsSection() {
  useEffect(() => {
    void startNotificationPrefs()
  }, [])
  const prefs = useNotificationPrefs((s) => s.prefs)
  const agents = useAssistants((s) => s.data?.agents ?? [])
  const [test, setTest] = useState<string | null>(null)
  const mute = (id: string, quiet: boolean) =>
    void saveNotificationPrefs({
      muted: quiet ? [...prefs.muted, id] : prefs.muted.filter((m) => m !== id),
    })
  return (
    <>
      <div className="eva-settings-card">
        <label className="eva-settings-row">
          <span className="eva-settings-label">
            <span className="eva-settings-label-title">Desktop notifications</span>
            <span className="eva-settings-label-help">
              Replies from your assistants, questions and approvals waiting on you, canvases to
              join, and an update that is ready. Clicking one opens that chat. Notifications show
              while you are using this Mac (any input in the last 10 minutes) and the chat is not in
              front. Otherwise your phone gets them.
            </span>
          </span>
          <Switch
            size="md"
            data-testid="settings-notifications-enabled"
            aria-label="Desktop notifications"
            checked={prefs.enabled}
            onChange={(e) => void saveNotificationPrefs({ enabled: e.currentTarget.checked })}
          />
        </label>
        <div className="eva-settings-row">
          <span className="eva-settings-label">
            <span className="eva-settings-label-title">Send a test</span>
            <span
              className="eva-settings-label-help"
              data-testid="settings-notifications-test-result"
            >
              {test ?? 'Shows one notification now, whatever the rules say.'}
            </span>
          </span>
          <Button
            variant="default"
            data-testid="settings-notifications-test"
            onClick={() =>
              void sendTestNotification().then((shown) =>
                setTest(
                  shown
                    ? 'Sent. Look in the top right corner, or in Notification Center.'
                    : 'This copy of Relay cannot show notifications.',
                ),
              )
            }
          >
            Send test
          </Button>
        </div>
      </div>
      {agents.length > 0 ? (
        <div className="eva-settings-card" data-testid="settings-notifications-assistants">
          {agents.map((a) => (
            <label key={a.id} className="eva-settings-row">
              <span className="eva-settings-label">
                <span className="eva-settings-label-title">{a.title}</span>
                <span className="eva-settings-label-help">
                  {prefs.muted.includes(a.id) ? 'Muted' : 'Notifies'}
                </span>
              </span>
              <Switch
                size="md"
                data-testid={`settings-notifications-assistant-${a.id}`}
                aria-label={`Notify for ${a.title}`}
                checked={!prefs.muted.includes(a.id)}
                disabled={!prefs.enabled}
                onChange={(e) => mute(a.id, !e.currentTarget.checked)}
              />
            </label>
          ))}
        </div>
      ) : null}
    </>
  )
}
