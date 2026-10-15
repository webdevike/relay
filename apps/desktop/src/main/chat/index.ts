import type { MainContext } from '../context'
import { registerTranscriptIpc } from './transcript-ipc'

export function registerChat(ctx: MainContext): void {
  registerTranscriptIpc(ctx)
}
