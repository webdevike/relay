/**
 * What Muse's window shows, read from cua-driver's accessibility snapshot (`get_window_state` structured
 * elements). Pure, so recorded snapshots replay in tests. Muse (com.meta.endo) is AppKit around one
 * WKWebView ("Hatch"); what this relies on, as Muse 9.0 draws it (2026-11-15):
 * - the side chat list has a "New side chat" button; a signed-out Muse has no window titled "Muse";
 * - the composer is one opaque button labelled "Message ... Attach file" plus "Send", or "Stop" while
 *   Muse is still answering (its text box is not in the tree, so typing goes to it by keyboard focus);
 * - after the chat list's "Resize panel" splitter, a message the user sent is "You:" then its text, and
 *   the answer is static text, links (a raw URL link is labelled with the URL; a preview card only with
 *   its host, "instagram.com instagram.com"), listing cards ("View details for <title>", no URL or price in
 *   the tree), titles inline in the text as buttons, and per-message buttons (React, Reply, More options).
 */

export interface Element {
  readonly element_index?: number
  readonly role?: string
  readonly label?: string
  readonly value?: string
  readonly element_token?: string
}

export interface MuseLink {
  readonly url: string
  /** The answer's lines just before the link: what Muse says about it. */
  readonly context: string
}

export interface MuseReply {
  /** The answer as text, one line per text element, raw URLs included. */
  readonly text: string
  /** Every http(s) link the answer shows, in order, once each. */
  readonly links: ReadonlyArray<MuseLink>
  /** Preview cards whose URL the tree does not expose (labelled only with a host). */
  readonly cards: number
  /** Titles of Marketplace listing cards (the tree shows neither their URL nor their price). */
  readonly listings: ReadonlyArray<string>
}

export interface MuseScreen {
  /** The "New side chat" button: the window is the signed-in chat UI, loaded. */
  readonly newChat: Element | undefined
  /** The composer is there; `working` is Muse still answering (Stop instead of Send). */
  readonly composer: boolean
  readonly working: boolean
  /** The user's messages in the open chat. */
  readonly sent: ReadonlyArray<string>
  /** Everything after the last message the user sent; undefined before one is sent. */
  readonly reply: MuseReply | undefined
}

const BUTTON_ROLES: Record<string, true> = { AXButton: true, AXPopUpButton: true }
/** Buttons Muse puts on every message, not part of what it says. */
const MESSAGE_ACTIONS: Record<string, true> = { React: true, Reply: true, "More options": true, "Copy response": true, "View all": true }
const LISTING = /^View details for (.+)$/
const URL_IN_TEXT = /https?:\/\/[^\s<>"'()\]]+[^\s<>"'()\].,;:!?]/g
/** Lines of Muse's text kept as a link's context: at most this many, and only those since the previous link. */
const CONTEXT_LINES = 2

/** Muse's text with its links: raw URL links are listed (cards counted), link labels are not repeated as text. */
const replyOf = (elements: ReadonlyArray<Element>): MuseReply => {
  const lines: Array<string> = []
  const links: Array<MuseLink> = []
  const listings: Array<string> = []
  const seen = new Set<string>()
  let cards = 0
  let linkLabel: string | undefined
  // Muse writes an item's words, then its link: what came since the last link is what it said about this one.
  let sinceLink: Array<string> = []
  const add = (url: string) => {
    const key = url.replace(/\/+$/, "")
    if (!seen.has(key)) {
      seen.add(key)
      links.push({ url, context: sinceLink.slice(-CONTEXT_LINES).join("\n") })
    }
    sinceLink = []
  }
  const say = (line: string) => {
    lines.push(line)
    sinceLink.push(line)
  }
  for (const element of elements) {
    const label = (element.label ?? "").trim()
    if (element.role === "AXLink") {
      linkLabel = label
      if (/^https?:\/\//.test(label)) {
        add(label)
        lines.push(label)
      } else if (/^([\w-]+\.)+[a-z]{2,}( ([\w-]+\.)+[a-z]{2,})*$/i.test(label)) {
        // A preview card ("instagram.com instagram.com") hides its URL.
        cards++
      } else if (label !== "") {
        // A titled link: its words are part of the sentence; its URL is not in the tree.
        say(label)
      }
      continue
    }
    if (BUTTON_ROLES[element.role ?? ""]) {
      // A listing card, or a title Muse set inline in its text as a button.
      const listing = LISTING.exec(label)?.[1]
      if (listing !== undefined) listings.push(listing)
      if (label !== "") say(listing === undefined ? label : `Listing: ${listing}`)
      continue
    }
    if (element.role !== "AXStaticText") continue
    const value = (element.value ?? element.label ?? "").trim()
    if (value === "") continue
    // The link's own text repeats its label; a card's host line repeats under it.
    if (linkLabel !== undefined && (value === linkLabel || linkLabel.split(" ").includes(value))) continue
    linkLabel = undefined
    lines.push(value)
    if (value.replace(URL_IN_TEXT, "").trim() !== "") sinceLink.push(value)
    for (const url of value.match(URL_IN_TEXT) ?? []) add(url)
  }
  return { text: lines.join("\n"), links, cards, listings }
}

export const readScreen = (elements: ReadonlyArray<Element>): MuseScreen => {
  const newChat = elements.find((element) => BUTTON_ROLES[element.role ?? ""] && element.label === "New side chat")
  const composer = elements.find((element) => element.role === "AXButton" && /^Message\b/.test(element.label ?? ""))
  const splitter = elements.findIndex((element) => element.role === "AXSplitter")
  const chat = splitter < 0 ? [] : elements.slice(splitter + 1, composer === undefined ? undefined : elements.indexOf(composer))
  const sent: Array<string> = []
  let lastSent = -1
  chat.forEach((element, index) => {
    if (element.role !== "AXStaticText" || (element.value ?? element.label) !== "You:") return
    // The message follows "You:": its text, and any link it holds.
    const parts: Array<string> = []
    for (const next of chat.slice(index + 1)) {
      if (next.role === "AXStaticText" && next.value !== "You:") parts.push((next.value ?? "").trim())
      else if (next.role !== "AXLink") break
    }
    sent.push(parts.join(" ").trim())
    lastSent = index
  })
  let reply: MuseReply | undefined
  if (lastSent >= 0) {
    // The answer starts after the sent message's own buttons.
    const after = chat.slice(lastSent + 1)
    const firstButton = after.findIndex((element) => BUTTON_ROLES[element.role ?? ""])
    const body = firstButton < 0 ? [] : after.slice(firstButton).filter((element) => !(BUTTON_ROLES[element.role ?? ""] && MESSAGE_ACTIONS[element.label ?? ""]))
    reply = replyOf(body)
  }
  return {
    newChat,
    composer: composer !== undefined,
    working: /\bStop\s*$/.test(composer?.label ?? ""),
    sent,
    reply
  }
}

/** Muse refusing for load, not for the question: the account is rate limited or out of messages. */
export const rateLimited = (text: string) =>
  text.length < 600 && /rate limit|too many (requests|messages)|(message|usage|daily) limit|limit reached|try again (later|in)|slow down/i.test(text)
