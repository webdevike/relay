// A chat room (Assistants > Rooms): its setup, its messages and its file. Created idle and saved
// at once to `<eva>/work/rooms/<id>/room.json` (the folder council rooms use), rewritten after
// every change, and listed again at the next launch exactly as it was.
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  ChatRoomSetupSchema,
  ROOM_ISAAC,
  UNTITLED_ROOM,
  autoTitle,
  mentionsIn,
  type ChatRoomSetup,
  type ChatRoomSetupPatch,
  type Room,
  type RoomAgent,
  type RoomMessage,
} from '@evaos/contract'
import { ROOM_STATE_VERSION, writeRoomState, type ChatRoomState } from './council/state'

/** Mantine colors members cycle through, so mentions and avatars stay apart. */
const COLORS = ['blue', 'orange', 'teal', 'violet', 'green', 'pink', 'cyan', 'grape'] as const

/** The members as the room's agents: what the feed, mentions and the phone read. */
export const chatAgents = (setup: ChatRoomSetup): RoomAgent[] =>
  setup.members.map((m, i) => ({
    id: m.id,
    name: m.name,
    title: m.role,
    role: m.role,
    brief: m.instructions ?? '',
    model: m.model,
    tools: 'full',
    color: COLORS[i % COLORS.length]!,
  }))

export interface ChatRoomDeps {
  /** `<eva>/work/rooms`: each room's folder is named by its id. */
  roomsDir: string
  onChange: (room: Room) => void
  log: (line: string) => void
}

export class ChatRoom {
  readonly room: Room
  private msgSeq: number

  private constructor(
    room: Room,
    private readonly deps: ChatRoomDeps,
  ) {
    this.room = room
    this.msgSeq = room.messages.length
  }

  /** A new idle room, on disk before this returns. */
  static create(id: string, setup: ChatRoomSetup, now: number, deps: ChatRoomDeps): ChatRoom {
    const room = new ChatRoom(
      {
        id,
        kind: 'chat',
        title: setup.title ?? UNTITLED_ROOM,
        prompt: '',
        agents: chatAgents(setup),
        messages: [],
        presence: {},
        phase: 'idle',
        rounds: 0,
        startedAt: now,
        chat: { setup, rev: 0 },
      },
      deps,
    )
    fs.mkdirSync(room.workdir, { recursive: true })
    room.save()
    return room
  }

  /** A room an earlier run of the app saved. */
  static restore(state: ChatRoomState, deps: ChatRoomDeps): ChatRoom {
    return new ChatRoom(structuredClone(state.room), deps)
  }

  /** `<eva>/work/rooms/<id>`: room.json now, the members' workdir once they run. */
  get workdir(): string {
    return path.join(this.deps.roomsDir, this.room.id)
  }

  get setup(): ChatRoomSetup {
    return this.room.chat!.setup
  }

  /** Applies `patch` (members replace the list, null clears a field); answers the new revision. */
  update(patch: ChatRoomSetupPatch): number {
    const merged: Record<string, unknown> = { ...this.setup }
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete merged[k]
      else if (v !== undefined) merged[k] = v
    }
    const setup = ChatRoomSetupSchema.parse(merged)
    const rev = this.room.chat!.rev + 1
    this.room.chat = { setup, rev }
    this.room.title = setup.title ?? UNTITLED_ROOM
    this.room.agents = chatAgents(setup)
    this.changed()
    return rev
  }

  rename(title: string): void {
    this.room.chat = { ...this.room.chat!, setup: { ...this.setup, title } }
    this.room.title = title
    this.changed()
  }

  /**
   * Isaac posts: the message is kept, and an unnamed room takes its title from it.
   * S2 hook: the room engine starts a round here (mentioned members first, then setup order). Until
   * it lands nobody answers, so the room stays idle and the UI says nothing about replies.
   */
  post(text: string): void {
    const body = text.trim()
    const msg: RoomMessage = {
      id: `m${++this.msgSeq}`,
      author: ROOM_ISAAC,
      text: body,
      ts: Date.now(),
      reactions: [],
      kind: 'message',
      mentions: mentionsIn(body, this.room.agents),
    }
    this.room.messages.push(msg)
    if (this.room.prompt === '') this.room.prompt = body
    if (this.setup.title === undefined) {
      const title = autoTitle(body)
      this.room.chat = { ...this.room.chat!, setup: { ...this.setup, title } }
      this.room.title = title
    }
    this.changed()
  }

  react(messageId: string, emoji: string): void {
    const m = this.room.messages.find((x) => x.id === messageId)
    if (!m) return
    const r = m.reactions.find((x) => x.emoji === emoji)
    if (!r) m.reactions.push({ emoji, by: [ROOM_ISAAC] })
    else if (r.by.includes(ROOM_ISAAC)) {
      r.by = r.by.filter((b) => b !== ROOM_ISAAC)
      if (r.by.length === 0) m.reactions = m.reactions.filter((x) => x !== r)
    } else r.by.push(ROOM_ISAAC)
    this.changed()
  }

  /** The app quits or the room is deleted: every change is already on disk and nothing runs. */
  destroy(): Promise<void> {
    return Promise.resolve()
  }

  private changed(): void {
    this.save()
    this.deps.onChange(this.room)
  }

  /** The room as it is now, on disk; a failed write is logged, never fatal. */
  private save(): void {
    const state: ChatRoomState = {
      version: ROOM_STATE_VERSION,
      kind: 'chat',
      room: { ...this.room, presence: {} },
    }
    try {
      writeRoomState(this.workdir, state)
    } catch (e) {
      this.deps.log(
        `${this.room.id}: could not save the room: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }
}
