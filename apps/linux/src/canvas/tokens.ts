// Tokens that open a canvas room's web client (`canvas.open` -> `canvas.access`). One per device
// and board, multi-use until it expires (page reloads, the websocket's reconnects and every image
// reuse it), bound to the human it was issued for. Memory only: a host restart invalidates them
// and the clients ask again.

import { randomBytes } from "node:crypto";
import { CANVAS_TOKEN_TTL_MS } from "@relay/protocol";

export interface CanvasGrant {
  readonly token: string;
  readonly slug: string;
  readonly deviceId: string;
  /** Who the page is: the name the room shows for this tab. */
  readonly human: string;
  readonly expiresAt: number;
}

export class CanvasTokens {
  private readonly grants = new Map<string, CanvasGrant>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The device's live token for `slug`, or a fresh one; expired grants are swept here. */
  issue(slug: string, deviceId: string, human: string): CanvasGrant {
    const now = this.now();
    let reuse: CanvasGrant | null = null;
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(token);
      // Reused only while most of its life is left, so a page opened now stays valid for hours.
      else if (grant.slug === slug && grant.deviceId === deviceId && grant.human === human && grant.expiresAt - now > CANVAS_TOKEN_TTL_MS / 2) reuse = grant;
    }
    if (reuse !== null) return reuse;
    const grant: CanvasGrant = { token: randomBytes(24).toString("base64url"), slug, deviceId, human, expiresAt: now + CANVAS_TOKEN_TTL_MS };
    this.grants.set(grant.token, grant);
    return grant;
  }

  /** The grant `token` holds for `slug`; null when unknown, expired or for another board. */
  check(slug: string, token: string | null): CanvasGrant | null {
    if (token === null || token === "") return null;
    const grant = this.grants.get(token);
    if (grant?.slug !== slug) return null;
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(token);
      return null;
    }
    return grant;
  }
}
