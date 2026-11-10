// The sign-in handoff: an assistant reply that needs Isaac to log in to a site ends with one last
// line `[[signin:<url>]]` (`eva-browser.ts handoff` prints it). The host, the phone and Relay
// desktop cut the token from the text and show a `Sign in to <host>` card instead; the card opens
// Eva's contained browser (`EVA_COMPUTER_URL`, already on that page) or a username and password
// form whose `assistant.signin` the host types into the page. One parser for every client.

/**
 * Eva's contained browser as a live web screen: the Selkies screen on the Mac Mini, published on the
 * tailnet by `tailscale serve` (MagicDNS name required, no auth: being on the tailnet is the auth).
 * See `workflows/eva-browser.md`.
 */
export const EVA_COMPUTER_URL = "https://isaacs-mac-mini.tail80fdb0.ts.net:3100/";

/** A reply's sign-in handoff: the login page and its hostname. */
export interface SigninHandoff {
  url: string;
  host: string;
}

/** The token a reply ends with. The url has no whitespace or `]`. */
const TOKEN = /[ \t\r\n]*\[\[signin:([^\]\s]+)\]\][ \t\r\n]*$/;
const OPENER = "[[signin:";

/** The hostname of an http(s) url; null for anything else. */
export function signinHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname.length > 0 ? parsed.hostname : null;
  } catch {
    return null;
  }
}

/**
 * Splits the sign-in token off the end of a reply. `signin` is set when the token carries an
 * http(s) url; a token with any other url is still cut from the text. While the reply is
 * `streaming`, a token that has only partly arrived is cut too, so no flicker of `[[sig` shows.
 * Cut a trailing `[[replies: ...]]` token first: it comes after this one.
 */
export function splitSignin(text: string, streaming: boolean): { text: string; signin?: SigninHandoff } {
  const match = TOKEN.exec(text);
  if (match !== null) {
    const url = match[1] ?? "";
    const stripped = text.slice(0, match.index);
    const host = signinHost(url);
    return host === null ? { text: stripped } : { text: stripped, signin: { url, host } };
  }
  if (!streaming) return { text };
  let start = text.lastIndexOf("[[");
  if (start < 0 && text.endsWith("[")) start = text.length - 1;
  if (start < 0) return { text };
  const tail = text.slice(start);
  const partial = !tail.includes("]]") && (OPENER.startsWith(tail) || (tail.startsWith(OPENER) && !/\s/.test(tail.slice(OPENER.length))));
  return partial ? { text: text.slice(0, start).trimEnd() } : { text };
}
