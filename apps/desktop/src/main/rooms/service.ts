// The rooms registry as one service: the renderer's rooms.* IPC (rooms-ipc.ts) and the phone's
// rooms.cmd frames relayed by Relay Host (relay/rooms-bridge.ts) both drive rooms through it, so
// a room started on the phone behaves exactly like one started on the desktop.
import type { Room, roomsInvoke } from '@evaos/contract'
import type { z } from 'zod'

/** What rooms.create takes: a debate room (`agentIds`) or a council room (`council`). */
export type RoomsCreateInput = z.output<(typeof roomsInvoke)['rooms.create']['input']>
export interface RoomsService {
  /** Every room, newest first. */
  list(): Room[]
  /** Called with a room after any change (debounced per room); returns an unsubscribe. */
  onChange(cb: (room: Room) => void): () => void
  create(input: RoomsCreateInput): Promise<{ roomId: string }>
  post(roomId: string, text: string): void
  react(roomId: string, messageId: string, emoji: string): void
  stop(roomId: string): Promise<void>
  /** One notch up; resolves with the new effort. */
  raise(roomId: string): Promise<number>
  /** The answer to the 80 % cap pause; resolves with the cap now in force. */
  budget(roomId: string, choice: 'continue' | 'wrap'): Promise<number>
  answer(roomId: string, askId: string, allow: boolean): void
  /**
   * A room image (a render or reference under the room's workdir or refs) as a JPEG data URL at
   * most `max` px on its long side; rejects paths outside the room.
   */
  image(roomId: string, path: string, max: number): Promise<string>
}

/** Errors the service throws carry one of these codes (passed through IPC and rooms.res). */
export type RoomsErrorCode =
  'no-room' | 'not-council' | 'too-many-rooms' | 'max-effort' | 'bad-path' | 'bad-input'
