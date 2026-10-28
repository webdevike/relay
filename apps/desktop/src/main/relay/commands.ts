// The commands this app sends Relay for a session it reads through Relay, ported from relay.rs
// (`Feed::request`). Each goes out as `{ t: 'cmd', id, cmd }` and Relay answers it with exactly one
// `ack` or `nack` (relay/packages/protocol/src/index.ts, `Command` and `AckError`). Subscriptions
// and reactions are plain frames with no answer.

/** Relay's image limits for one reply (protocol `AgentImage`, `MAX_REPLY_IMAGES`). */
export const RELAY_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export const MAX_RELAY_IMAGES = 4
export const MAX_RELAY_IMAGE_BASE64 = 6 * 1024 * 1024

export const NO_GIF = 'Relay takes PNG, JPEG and WebP images, not GIF.'
export const TOO_MANY_IMAGES = `Relay takes up to ${MAX_RELAY_IMAGES} images per message.`
export const IMAGE_TOO_LARGE = 'Relay takes images up to about 4.5 MB each.'

type RelayImageType = (typeof RELAY_IMAGE_TYPES)[number]
export interface RelayImage {
  mimeType: RelayImageType
  data: string
}

/** The answer to one question: the picked option labels, or text typed instead. */
export type RelayAnswer = { id: string; picked: string[] } | { id: string; typed: string }

/**
 * One `agent.reply` is both a prompt and a steer: omp's bridge hands it to `sendUserMessage`, the
 * TUI's Enter, which starts a turn when the session is idle and steers it while it replies (relay
 * apps/linux/omp-extension/relay-bridge.ts, `case "reply"`). So, like native, this app always
 * sends the same command and never picks.
 */
export type RelayCommand =
  | {
      kind: 'agent.reply'
      sessionId: string
      text: string
      submit: true
      images?: RelayImage[]
    }
  | { kind: 'agent.abort'; sessionId: string }
  | {
      kind: 'agent.configure'
      sessionId: string
      title?: string
      model?: { provider: string; id: string }
      thinkingLevel?: string
    }
  | {
      kind: 'agent.ask.answer'
      sessionId: string
      askId: string
      results: Array<{ id: string; selectedOptions: string[]; customInput?: string }>
    }
  | { kind: 'agent.ask.cancel'; sessionId: string; askId: string }
  | { kind: 'agent.approve'; sessionId: string; approvalId: string; confirmed: 'desktop' }
  | { kind: 'agent.deny'; sessionId: string; approvalId: string }
  /** Isaac's words to registry agent `agent`'s thread; the host starts the thread if needed. */
  | { kind: 'assistant.turn'; agent: string; text: string }

/**
 * Relay's images for a reply, or why Relay would refuse them (native reply_away's GIF check, plus
 * the protocol's count and size limits, so the refusal is said here rather than nacked).
 */
export function relayImages(
  images: ReadonlyArray<{ mimeType: string; data: string }>,
): RelayImage[] | string {
  if (images.length > MAX_RELAY_IMAGES) return TOO_MANY_IMAGES
  const out: RelayImage[] = []
  for (const image of images) {
    const type = RELAY_IMAGE_TYPES.find((t) => t === image.mimeType)
    if (type === undefined) return NO_GIF
    if (image.data.length > MAX_RELAY_IMAGE_BASE64) return IMAGE_TOO_LARGE
    out.push({ mimeType: type, data: image.data })
  }
  return out
}

/** `text` (already surface-tagged) and images as the session's next turn, or a steer. */
export function replyCommand(
  sessionId: string,
  text: string,
  images: readonly RelayImage[] = [],
): RelayCommand {
  return {
    kind: 'agent.reply',
    sessionId,
    text,
    submit: true,
    ...(images.length > 0 ? { images: [...images] } : {}),
  }
}

/** Renames the session and/or switches its model and thinking level; unset fields stay. */
export function configureCommand(
  sessionId: string,
  change: { title?: string; model?: readonly [string, string]; thinking?: string },
): RelayCommand {
  return {
    kind: 'agent.configure',
    sessionId,
    ...(change.title !== undefined ? { title: change.title } : {}),
    ...(change.model !== undefined
      ? { model: { provider: change.model[0], id: change.model[1] } }
      : {}),
    ...(change.thinking !== undefined ? { thinkingLevel: change.thinking } : {}),
  }
}

export function answerCommand(
  sessionId: string,
  askId: string,
  answers: readonly RelayAnswer[],
): RelayCommand {
  return {
    kind: 'agent.ask.answer',
    sessionId,
    askId,
    results: answers.map((a) =>
      'typed' in a
        ? { id: a.id, selectedOptions: [], customInput: a.typed }
        : { id: a.id, selectedOptions: [...a.picked] },
    ),
  }
}

/**
 * Approves (`allow`) or denies a tool call. Approving says Isaac is at this Mac, in front of the
 * command, which Relay needs for a destructive one (`confirmed: desktop`, native Request::Decide).
 */
export function decideCommand(sessionId: string, approvalId: string, allow: boolean): RelayCommand {
  return allow
    ? { kind: 'agent.approve', sessionId, approvalId, confirmed: 'desktop' }
    : { kind: 'agent.deny', sessionId, approvalId }
}

/** The frame that carries `cmd` under the client-made id Relay acks it by. */
export function cmdFrame(id: string, cmd: RelayCommand): Record<string, unknown> {
  return { t: 'cmd', id, cmd }
}

export function subscribeFrame(sessionId: string): Record<string, unknown> {
  return { t: 'agent.subscribe', sessionId }
}

export function unsubscribeFrame(sessionId: string): Record<string, unknown> {
  return { t: 'agent.unsubscribe', sessionId }
}

/** Asks for `thread`'s reactions; Relay answers with its `reactions.snapshot`. */
export function reactionsGetFrame(thread: string): Record<string, unknown> {
  return { t: 'reactions.get', thread }
}

/**
 * Reacts `emoji` to bubble `message` (its reaction key) of `thread`, or takes the reaction back
 * (null). Every device gets the thread's new snapshot, this one too.
 */
export function reactionFrame(
  thread: string,
  message: string,
  emoji: string | null,
  excerpt: string,
): Record<string, unknown> {
  return emoji === null
    ? { t: 'reaction.clear', thread, message }
    : { t: 'reaction.set', thread, message, emoji, excerpt }
}
