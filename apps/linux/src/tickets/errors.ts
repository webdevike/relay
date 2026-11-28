// What a tickets failure says to clients and in the host log: stable lines in the host's own words,
// never a provider's raw error text (which can echo request content or internals). Errors the host
// words itself (HostError, RateLimited, a ProviderRejected's `publicMessage`) pass as they are;
// anything else becomes one generic line per provider.

import { RateLimited } from "./budget";

/** The provider answered and refused: nothing was written (any other throw is a lost response). */
export class ProviderRejected extends Error {
  override readonly name = "ProviderRejected";
  constructor(
    message: string,
    /** What clients and logs see; the provider's own text stays in `message`. */
    readonly publicMessage: string = message,
  ) {
    super(message);
  }
}

/** The pinned key or account changed before a mutation went out: that mutation was not sent. */
export class StaleCredential extends ProviderRejected {
  constructor() {
    super("tickets: credential changed before the write", "The host's Linear key or account changed while writing. Reload and try again.");
  }
}

/** A failure in the host's own words, safe to show as it is. */
export class HostError extends Error {
  override readonly name = "HostError";
}

/** The line a client or the log gets for `error`; `provider` names who was being reached. */
export function publicError(error: unknown, provider: "Linear" | "GitHub" | "Linear or GitHub" = "Linear or GitHub"): string {
  if (error instanceof ProviderRejected) return error.publicMessage;
  if (error instanceof RateLimited || error instanceof HostError) return error.message;
  return `Couldn't reach ${provider}. Try again in a moment.`;
}
