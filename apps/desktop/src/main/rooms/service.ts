// The rooms registry as one service: the renderer's rooms.* IPC (rooms-ipc.ts) and the phone's
// rooms.cmd frames relayed by Relay Host (relay/rooms-bridge.ts) both drive rooms through it, so
// a room started on the phone behaves exactly like one started on the desktop.
import type {
  ChatRoomSetup,
  ChatRoomSetupPatch,
  DecideAction,
  Room,
  roomsInvoke,
} from '@evaos/contract'
import type { z } from 'zod'

/** What rooms.create takes: a council room (prompt and notch). */
export type RoomsCreateInput = z.output<(typeof roomsInvoke)['rooms.create']['input']>
export interface RoomsService {
  /** Every room, latest activity first. */
  list(): Room[]
  /** Called with a room after any change (debounced per room); returns an unsubscribe. */
  onChange(cb: (room: Room) => void): () => void
  /** Called with a room's id once it is deleted; returns an unsubscribe. */
  onRemove(cb: (roomId: string) => void): () => void
  /** A council room; it starts at once. */
  create(input: RoomsCreateInput): Promise<{ roomId: string }>
  /** A chat room, idle until Isaac's first message; every member's model is checked against omp's catalog. */
  open(setup: ChatRoomSetup): Promise<{ roomId: string }>
  /** Changes a chat room's setup; resolves with its new revision. */
  update(roomId: string, patch: ChatRoomSetupPatch): Promise<number>
  rename(roomId: string, title: string): void
  /** A chat room's copy: the same setup, no messages, idle. */
  duplicate(roomId: string): { roomId: string }
  /** Stops the room if it runs, drops it and deletes its folder under `<eva>/work/rooms`. */
  delete(roomId: string): Promise<void>
  post(roomId: string, text: string): void
  react(roomId: string, messageId: string, emoji: string): void
  /** Council: resolve now. */
  stop(roomId: string): Promise<void>
  /** Council: stop at the end of the round it is in. Chat: stop the turn now. The state stays on disk. */
  pause(roomId: string): void
  /**
   * Council: run a paused, wrapped or failed room on from its next round. Chat: go on with the
   * burst (refused while its next turn would cross the budget). Resolves with the cap.
   */
  resume(roomId: string): Promise<number>
  /** One notch up; resolves with the new effort. */
  raise(roomId: string): Promise<number>
  /** The answer to the 80 % cap pause; resolves with the cap now in force. */
  budget(roomId: string, choice: 'continue' | 'wrap'): Promise<number>
  answer(roomId: string, askId: string, allow: boolean): void
  // Chat rooms' decision cards (`cardId`: the message that carries the card).
  /** Isaac's vote on a poll; null takes it back. */
  vote(roomId: string, cardId: string, option: string | null): void
  callPoll(roomId: string, cardId: string, option?: string): void
  reopenPoll(roomId: string, cardId: string): void
  /** Marks the question answered and posts the answer (the members talk again). */
  answerAsk(roomId: string, cardId: string, answer: string): void
  decide(roomId: string, cardId: string, action: DecideAction, option?: string): void
  /**
   * A room image (a render or reference under the room's workdir or refs) as a JPEG data URL at
   * most `max` px on its long side; rejects paths outside the room.
   */
  image(roomId: string, path: string, max: number): Promise<string>
}

/** Errors the service throws carry one of these codes (passed through IPC and rooms.res). */
export type RoomsErrorCode =
  | 'no-room'
  | 'not-council'
  | 'not-chat'
  | 'too-many-rooms'
  | 'max-effort'
  | 'bad-path'
  | 'bad-input'
