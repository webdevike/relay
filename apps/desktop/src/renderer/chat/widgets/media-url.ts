/**
 * The `relay-media:` URL main serves a widget's media `src` from (a Relay drop, an http(s) URL
 * downloaded once, or an allowed local file). See src/main/chat/widget-media.ts.
 */
export function mediaUrl(src: string): string {
  return `relay-media://media/?src=${encodeURIComponent(src)}`
}
