// One request budget per provider (Linear, GitHub), shared by the tickets sync and Reviews' clients
// when host.json opts into tickets (with tickets off Reviews stays unpaced, as before). A token
// bucket paces calls on our side; the last `reserve` tokens are kept for interactive calls
// (Reviews, ticket writes): the sync takes through `background`, which is refused while only the
// reserve is left. The provider's own answers move the bucket: Linear's
// `x-ratelimit-requests-*`/`x-ratelimit-complexity-*` headers and 429 `Retry-After`, GitHub's
// `x-ratelimit-remaining`/`-reset` and a secondary limit (403 or 429 with `retry-after`). While
// backing off every call is refused at once with `RateLimited`, which carries how long to wait;
// nothing here sleeps or schedules.

export type BudgetProvider = "linear" | "github";

/** A call refused (or answered 429) because the provider's limit is spent; retry after `waitMs`. */
export class RateLimited extends Error {
  override readonly name = "RateLimited";
  constructor(
    readonly provider: BudgetProvider,
    readonly waitMs: number,
  ) {
    super(`${provider === "linear" ? "Linear" : "GitHub"} rate limit: retry in ${String(Math.ceil(waitMs / 1000))} s`);
  }
}

export interface BudgetFacts {
  readonly remaining: number | null;
  readonly resetAt: number | null;
  readonly backoffUntil: number | null;
}

/** Headers as `fetch` gives them or as parsed from `gh api --include`. */
export interface HeaderBag {
  get(name: string): string | null;
}

/** Without a Retry-After, a limit answer backs off this long. */
const DEFAULT_BACKOFF_MS = 60_000;

const num = (v: string | null): number | null => {
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** `Retry-After` in seconds (or an HTTP date) as ms from `now`. */
export function retryAfterMs(value: string | null, now: number): number | null {
  const seconds = num(value);
  if (seconds !== null) return Math.max(0, seconds * 1000);
  const at = value === null ? NaN : Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** A reset header as epoch ms: Linear sends ms, GitHub seconds. */
const resetMs = (v: string | null): number | null => {
  const n = num(v);
  if (n === null) return null;
  return n < 1e12 ? n * 1000 : n;
};

/** What a client calls through: Reviews and writes take the provider budget, the sync its `background` lane. */
export interface Budget {
  /** Takes one call's token, or throws RateLimited. */
  take(): void;
  /** Reads an answer's limit headers; throws RateLimited when the answer was a limit. */
  observe(status: number, headers: HeaderBag): void;
  /** A limit seen without headers: backs off and throws RateLimited. */
  limited(waitMs?: number | null): never;
}

export class ProviderBudget implements Budget {
  private tokens: number;
  private filledAt: number;
  private remaining: number | null = null;
  private resetAt: number | null = null;
  private backoffUntil: number | null = null;
  /** The sync's lane: refused while only the interactive reserve is left. */
  readonly background: Budget = {
    take: () => this.takeAbove(this.reserve),
    observe: (status, headers) => this.observe(status, headers),
    limited: (waitMs) => this.limited(waitMs),
  };

  constructor(
    readonly provider: BudgetProvider,
    private readonly now: () => number,
    /** Calls allowed in a burst. */
    private readonly capacity: number,
    /** Tokens back per second. */
    private readonly perSecond: number,
    /** Tokens only interactive calls (`take`) may spend. */
    private readonly reserve = 0,
  ) {
    this.tokens = capacity;
    this.filledAt = now();
  }

  /** An interactive call's token, or RateLimited while backing off or out of tokens. */
  take(): void {
    this.takeAbove(0);
  }

  /** Takes one token when more than `floor` are left; otherwise throws RateLimited. */
  private takeAbove(floor: number): void {
    const now = this.now();
    if (this.backoffUntil !== null && now < this.backoffUntil) throw new RateLimited(this.provider, this.backoffUntil - now);
    this.backoffUntil = null;
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.filledAt) / 1000) * this.perSecond);
    this.filledAt = now;
    if (this.tokens < floor + 1) throw new RateLimited(this.provider, Math.ceil(((floor + 1 - this.tokens) / this.perSecond) * 1000));
    this.tokens -= 1;
  }

  /** Reads an answer's limit headers; throws RateLimited when the answer was a limit. */
  observe(status: number, headers: HeaderBag): void {
    const now = this.now();
    if (this.provider === "linear") this.linearHeaders(headers);
    else this.githubHeaders(headers);
    if (this.isLimit(status, headers)) this.backOff(retryAfterMs(headers.get("retry-after"), now) ?? this.untilReset(now));
    if (this.remaining === 0 && this.resetAt !== null && this.resetAt > now) this.backoffUntil = this.resetAt;
  }

  /** A 429, or GitHub's secondary (403 + retry-after) or spent primary (403 at 0 left) limit. */
  private isLimit(status: number, headers: HeaderBag): boolean {
    if (status === 429) return true;
    return this.provider === "github" && status === 403 && (headers.get("retry-after") !== null || this.remaining === 0);
  }

  /** A limit seen without headers (Linear's RATELIMITED error, gh's "rate limit" text). */
  limited(waitMs: number | null = null): never {
    this.backOff(waitMs ?? this.untilReset(this.now()));
  }

  facts(): BudgetFacts {
    const now = this.now();
    return {
      remaining: this.remaining,
      resetAt: this.resetAt,
      backoffUntil: this.backoffUntil !== null && this.backoffUntil > now ? this.backoffUntil : null,
    };
  }

  private untilReset(now: number): number {
    return this.resetAt !== null && this.resetAt > now ? this.resetAt - now : DEFAULT_BACKOFF_MS;
  }

  private backOff(waitMs: number): never {
    this.backoffUntil = this.now() + waitMs;
    throw new RateLimited(this.provider, waitMs);
  }

  private linearHeaders(h: HeaderBag): void {
    const requests = num(h.get("x-ratelimit-requests-remaining"));
    const complexity = num(h.get("x-ratelimit-complexity-remaining"));
    const left = [requests, complexity].filter((n): n is number => n !== null);
    if (left.length > 0) this.remaining = Math.min(...left);
    // The spent window decides when calls come back.
    const spentReset = requests === 0 || complexity === null || complexity > 0 ? h.get("x-ratelimit-requests-reset") : h.get("x-ratelimit-complexity-reset");
    this.resetAt = resetMs(spentReset) ?? this.resetAt;
  }

  private githubHeaders(h: HeaderBag): void {
    this.remaining = num(h.get("x-ratelimit-remaining")) ?? this.remaining;
    this.resetAt = resetMs(h.get("x-ratelimit-reset")) ?? this.resetAt;
  }
}

export interface Budgets {
  readonly linear: ProviderBudget;
  readonly github: ProviderBudget;
}

/**
 * Linear allows 1,500 requests an hour per key, GitHub 5,000: we pace below both, and keep a
 * quarter of each burst for Reviews and ticket writes.
 */
export function providerBudgets(now: () => number): Budgets {
  return {
    linear: new ProviderBudget("linear", now, 40, 1200 / 3600, 10),
    github: new ProviderBudget("github", now, 60, 4000 / 3600, 15),
  };
}
