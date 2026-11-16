import { notifications } from '@mantine/notifications'
import { sendToAssistant } from '../assistants/assistant-send'

/**
 * Posts `text` into assistant `agent`'s thread as Isaac, as if he typed it there, and says so in
 * red when it could not. The host adds the meeting's transcript itself; the text is only the question.
 */
export async function askInChat(agent: string, text: string): Promise<string | null> {
  const failed = await sendToAssistant(agent, text)
  if (failed !== null) notifications.show({ message: failed, color: 'red', autoClose: 6000 })
  return failed
}
