/**
 * The sign-in handoff in Eva's thread: a card on her reply opens her browser as a sheet (already on
 * the login page), whose `Password` form sends the site's credentials to the host
 * (`assistant.signin`), which types them into that page. The model never sees them; nothing here
 * stores or logs them.
 */

/** The site's icon, as Google's favicon service serves it, at 2x for a 32pt tile. */
export function faviconUrl(host: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

/** What the sheet shows when the host nacks or the connection drops. */
export function signinFailure(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "Couldn't sign in.";
}
