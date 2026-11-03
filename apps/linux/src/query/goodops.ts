// `goodops_collections`: GoodOps AI Collections for Pest Control Consultants, aggregated on the host
// so only counts and totals leave it. Calls come from GoodOps' Neon database through the
// `relay_readonly` role (SELECT on five columns of delinquency_calls, read-only transactions); the
// delinquent book and payments come from FieldRoutes' search endpoints (reads only). Both credentials
// live in `<agent home>/secrets/goodops-readonly.env`. Customer ids are used only to ask FieldRoutes
// for payments and never appear in the result.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QueryArgs } from "@relay/protocol";
import { z } from "zod";

/** One SQL statement with positional params; rows as plain objects. */
export type GoodOpsSql = (text: string, params: readonly unknown[]) => Promise<readonly Record<string, unknown>[]>;

export interface GoodOpsSource {
  readonly sql: GoodOpsSql;
  readonly fr: { readonly subdomain: string; readonly key: string; readonly token: string };
}

export interface GoodOpsDeps {
  /** Null: no secrets/goodops-readonly.env (the tool fails with that reason). */
  readonly goodops: () => GoodOpsSource | null;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly now: () => number;
}

const ENV_FILE = "goodops-readonly.env";

function envValue(text: string, key: string): string | null {
  const m = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*["']?([^"'\\s]+)`, "m").exec(text);
  return m?.[1] ?? null;
}

/**
 * The read-only source from `<agentHome>/secrets/goodops-readonly.env`, read again on each call so a
 * rotated password needs no restart; one Bun SQL pool per database URL.
 */
export function goodopsSource(agentHome: string | null): () => GoodOpsSource | null {
  let pool: { url: string; sql: InstanceType<typeof Bun.SQL> } | null = null;
  return () => {
    if (agentHome === null) return null;
    let text: string;
    try {
      text = readFileSync(join(agentHome, "secrets", ENV_FILE), "utf8");
    } catch {
      return null;
    }
    const url = envValue(text, "GOODOPS_READONLY_DATABASE_URL");
    const subdomain = envValue(text, "PESTROUTES_SUBDOMAIN");
    const key = envValue(text, "PESTROUTES_AUTH_KEY");
    const token = envValue(text, "PESTROUTES_AUTH_TOKEN");
    if (url === null || subdomain === null || key === null || token === null) return null;
    if (pool?.url !== url) {
      void pool?.sql.close();
      pool = { url, sql: new Bun.SQL(url, { max: 2, idleTimeout: 60 }) };
    }
    const sql = pool.sql;
    return { sql: (q, params) => sql.unsafe(q, [...params]), fr: { subdomain, key, token } };
  };
}

/** PCC's branches are Central; FieldRoutes stamps payments in Pacific, two hours behind all year. */
const ZONE = "America/Chicago";
const FR_TO_CENTRAL_MS = 2 * 3_600_000;
const FR_TIMEOUT_MS = 15_000;
const FR_PAGE = 1000;
const BOOK_TTL_MS = 30 * 60_000;
const OFFICES_TTL_MS = 6 * 3_600_000;
const PAYMENTS_TTL_MS = 10 * 60_000;
/** Offices GoodOps leaves out of the program (Michigan), as its dashboard does; "TEMP" offices too. */
const EXCLUDED_OFFICES: Record<string, true> = { "8": true };

const BUCKETS = [
  { label: "1-29d", min: 1, max: 29 },
  { label: "30-59d", min: 30, max: 59 },
  { label: "60-89d", min: 60, max: 89 },
  { label: "90d+", min: 90, max: Infinity },
] as const;

/** delinquency_calls.status, in the order the cards list them. */
const STATUS_NAMES: Record<string, string> = {
  answered: "Answered",
  paid: "Answered",
  voicemail: "Voicemail",
  no_answer: "No answer",
  opted_out: "Opted out",
  failed: "Failed",
  dispatched: "Pending",
};
/** Rows that never became a call: SMS-only touches, queue entries and stopped batches. */
const NOT_PLACED: Record<string, true> = { texted: true, queued: true, cancelling: true, cancelled: true, dropped: true };

/** GoodOps' office follow-up flags (apps/api/src/lib/delinquency/office-flags.ts), as the office reads them. */
const FLAG_NAMES: Record<string, string> = {
  dispute: "Disputes the balance",
  already_paid: "Says already paid",
  hardship: "Health or hardship",
  wrong_party: "Wrong person or number",
  callback: "Callback requested",
  refused_ai: "Refused the AI",
  pay_link_undelivered: "Pay link not received",
};
/** Payment sources a person chose (not autopay or imports). */
const CUSTOMER_DRIVEN: Record<string, true> = { "Customer Portal": true, Manual: true };

const DAYS: Record<QueryArgs<"goodops_collections">["range"], number> = { today: 1, "7d": 7, "30d": 30 };

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const money = (cents: number) => ({ amount: Math.round(cents) / 100, amountText: usd.format(Math.round(cents / 100)) });
const centralDay = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE });
const centralClock = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** YYYY-MM-DD `back` days before the Central day of `ms`. */
function dayBefore(ms: number, back: number): string {
  const [y, m, d] = centralDay.format(ms).split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - back)).toISOString().slice(0, 10);
}

/** FieldRoutes' "YYYY-MM-DD HH:MM:SS" (Pacific) as the same instant in Central, same format. */
function frToCentral(stamp: string): string {
  const t = Date.parse(`${stamp.replace(" ", "T")}Z`);
  return Number.isNaN(t) ? "" : new Date(t + FR_TO_CENTRAL_MS).toISOString().slice(0, 19).replace("T", " ");
}

const IdSearch = z.object({ customerIDs: z.array(z.union([z.number(), z.string()])).optional(), paymentIDs: z.array(z.union([z.number(), z.string()])).optional() });
/** FieldRoutes lists rows as an array, or keyed by id on some endpoints. */
const FrRows = <T extends z.ZodType>(row: T) => z.union([z.array(row), z.record(z.string(), row)]);
const Offices = z.object({ offices: FrRows(z.unknown()) });
const Office = z.object({ officeID: z.union([z.string(), z.number()]), officeName: z.string() });
const BookCustomers = z.object({ customers: FrRows(z.object({ responsibleBalance: z.string().nullish(), responsibleBalanceAge: z.string().nullish() })).optional() });
const Payments = z.object({
  payments: FrRows(
    z.object({ customerID: z.string(), date: z.string(), amount: z.string(), status: z.string(), writeOff: z.string().nullish(), paymentSource: z.string().nullish() }),
  ).optional(),
});

interface Book {
  accounts: number;
  cents: number;
  buckets: { bucket: string; accounts: number; cents: number }[];
  at: number;
}
interface Paid {
  count: number;
  customers: number;
  cents: number;
  driven: { count: number; cents: number };
  perDay: Map<string, { count: number; cents: number }>;
}

/** A value kept for `ttlMs`, one load in flight at a time. */
function cached<T>(ttlMs: number, now: () => number) {
  const entries = new Map<string, { at: number; value: T }>();
  const loading = new Map<string, Promise<T>>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = entries.get(key);
    if (hit !== undefined && now() - hit.at < ttlMs) return Promise.resolve(hit.value);
    let p = loading.get(key);
    if (p === undefined) {
      p = load()
        .then((value) => {
          entries.set(key, { at: now(), value });
          return value;
        })
        .finally(() => loading.delete(key));
      loading.set(key, p);
    }
    return p;
  };
}

export function goodopsCollections(deps: GoodOpsDeps): (args: QueryArgs<"goodops_collections">) => Promise<unknown> {
  const officeCache = cached<string[]>(OFFICES_TTL_MS, deps.now);
  const bookCache = cached<Book>(BOOK_TTL_MS, deps.now);
  const paidCache = cached<Paid>(PAYMENTS_TTL_MS, deps.now);

  const fr = async <T>(source: GoodOpsSource, endpoint: string, params: Record<string, string>, schema: z.ZodType<T>): Promise<T> => {
    const res = await deps.fetch(`https://${source.fr.subdomain}.pestroutes.com/api/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ authenticationKey: source.fr.key, authenticationToken: source.fr.token, ...params }).toString(),
      signal: AbortSignal.timeout(FR_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`FieldRoutes answered ${String(res.status)} on ${endpoint}`);
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success) throw new Error(`FieldRoutes answered something unexpected on ${endpoint}`);
    return parsed.data;
  };

  const offices = (source: GoodOpsSource) =>
    officeCache("offices", async () => {
      const data = await fr(source, "office/search", { includeData: "1" }, Offices);
      return Object.values(data.offices)
        .map((o) => Office.safeParse(o))
        .flatMap((o) => (o.success ? [o.data] : []))
        .filter((o) => !/temp/i.test(o.officeName) && EXCLUDED_OFFICES[String(o.officeID)] !== true)
        .map((o) => String(o.officeID));
    });

  /** Every active account with a balance at least a day old: an uncapped id search, then details in pages. */
  const book = (source: GoodOpsSource) =>
    bookCache("book", async () => {
      const buckets = BUCKETS.map((b) => ({ bucket: b.label, accounts: 0, cents: 0 }));
      let accounts = 0;
      let cents = 0;
      for (const office of await offices(source)) {
        const ids = await fr(
          source,
          "customer/search",
          { officeIDs: office, active: "1", responsibleBalance: JSON.stringify({ operator: ">", value: 0 }), responsibleBalanceAge: JSON.stringify({ operator: ">=", value: 1 }) },
          IdSearch,
        );
        const all = (ids.customerIDs ?? []).map(Number);
        for (let i = 0; i < all.length; i += FR_PAGE) {
          const page = await fr(source, "customer/search", { officeIDs: office, customerIDs: JSON.stringify(all.slice(i, i + FR_PAGE)), includeData: "1" }, BookCustomers);
          for (const c of Object.values(page.customers ?? {})) {
            const due = Math.round(parseFloat(c.responsibleBalance ?? "0") * 100);
            if (!(due > 0)) continue;
            const age = parseInt(c.responsibleBalanceAge ?? "0", 10);
            accounts++;
            cents += due;
            const bucket = buckets[BUCKETS.findIndex((b) => age >= b.min && age <= b.max)];
            if (bucket !== undefined) {
              bucket.accounts++;
              bucket.cents += due;
            }
          }
        }
      }
      return { accounts, cents, buckets, at: deps.now() };
    });

  /** Settled payments from `from` on by customers the AI had contacted before paying. */
  const payments = (source: GoodOpsSource, from: string) =>
    paidCache(from, async () => {
      const rows = await source.sql(
        `select field_routes_customer_id as customer, office_id as office,
                to_char(min(created_at) at time zone 'UTC' at time zone '${ZONE}', 'YYYY-MM-DD HH24:MI:SS') as first
           from delinquency_calls group by 1, 2`,
        [],
      );
      const byOffice = new Map<string, Map<string, string>>();
      for (const r of rows) {
        const office = String(r["office"]);
        const firsts = byOffice.get(office) ?? new Map<string, string>();
        firsts.set(String(r["customer"]), String(r["first"]));
        byOffice.set(office, firsts);
      }
      // FieldRoutes filters on its Pacific date: ask from the day before and keep Central days in range.
      const since = dayBefore(Date.parse(`${from}T12:00:00Z`), 1);
      const result: Paid = { count: 0, customers: 0, cents: 0, driven: { count: 0, cents: 0 }, perDay: new Map() };
      const payers = new Set<string>();
      for (const [office, firsts] of byOffice) {
        const ids = await fr(
          source,
          "payment/search",
          { officeIDs: office, customerIDs: JSON.stringify([...firsts.keys()].map(Number)), date: JSON.stringify({ operator: ">=", value: since }) },
          IdSearch,
        );
        const all = (ids.paymentIDs ?? []).map(Number);
        for (let i = 0; i < all.length; i += FR_PAGE) {
          const page = await fr(source, "payment/search", { officeIDs: office, paymentIDs: JSON.stringify(all.slice(i, i + FR_PAGE)), includeData: "1" }, Payments);
          for (const p of Object.values(page.payments ?? {})) {
            const at = frToCentral(p.date);
            const first = firsts.get(p.customerID);
            const cents = Math.round(parseFloat(p.amount) * 100);
            if (p.status !== "1" || p.writeOff === "1" || !(cents > 0) || at.slice(0, 10) < from || first === undefined || at <= first) continue;
            result.count++;
            result.cents += cents;
            payers.add(`${office}:${p.customerID}`);
            if (CUSTOMER_DRIVEN[p.paymentSource ?? ""] === true) {
              result.driven.count++;
              result.driven.cents += cents;
            }
            const day = result.perDay.get(at.slice(0, 10)) ?? { count: 0, cents: 0 };
            day.count++;
            day.cents += cents;
            result.perDay.set(at.slice(0, 10), day);
          }
        }
      }
      result.customers = payers.size;
      return result;
    });

  return async (args) => {
    const source = deps.goodops();
    if (source === null) throw new Error(`no GoodOps read-only access (secrets/${ENV_FILE})`);
    const now = deps.now();
    const span = DAYS[args.range];
    const days = Array.from({ length: span }, (_, i) => dayBefore(now, span - 1 - i));
    const from = days[0] ?? dayBefore(now, 0);
    const to = days[days.length - 1] ?? from;
    const unavailable = ["Promise-to-pay outcomes are not tracked by GoodOps yet"];

    const [callRows, bookResult, paidResult] = await Promise.all([
      source.sql(
        `select to_char(created_at at time zone 'UTC' at time zone '${ZONE}', 'YYYY-MM-DD') as day, status, office_flags as flags, count(*)::int as n
           from delinquency_calls
          where (created_at at time zone 'UTC' at time zone '${ZONE}')::date >= $1::date
          group by 1, 2, 3`,
        [from],
      ),
      book(source).then(
        (b) => b,
        (err: unknown) => {
          unavailable.push(`Delinquent book: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        },
      ),
      payments(source, from).then(
        (p) => p,
        (err: unknown) => {
          unavailable.push(`Payments: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        },
      ),
    ]);

    const perDay = new Map(days.map((d) => [d, { placed: 0, connected: 0 }]));
    const byStatus = new Map<string, number>();
    const flags = new Map<string, number>();
    const tally = { placed: 0, connected: 0, voicemail: 0, noAnswer: 0, failed: 0, optedOut: 0, pending: 0 };
    for (const r of callRows) {
      const status = String(r["status"]);
      const n = Number(r["n"]);
      const day = perDay.get(String(r["day"]));
      if (NOT_PLACED[status] === true || day === undefined) continue;
      const connected = status === "answered" || status === "paid";
      tally.placed += n;
      day.placed += n;
      if (connected) {
        tally.connected += n;
        day.connected += n;
      }
      if (status === "voicemail") tally.voicemail += n;
      if (status === "no_answer") tally.noAnswer += n;
      if (status === "failed") tally.failed += n;
      if (status === "opted_out") tally.optedOut += n;
      if (status === "dispatched") tally.pending += n;
      const name = STATUS_NAMES[status] ?? status;
      byStatus.set(name, (byStatus.get(name) ?? 0) + n);
      for (const flag of Array.isArray(r["flags"]) ? (r["flags"] as unknown[]) : []) {
        const label = FLAG_NAMES[String(flag)] ?? String(flag);
        flags.set(label, (flags.get(label) ?? 0) + n);
      }
    }
    // Biggest first, ties by name.
    const [statusCounts, flagCounts] = [byStatus, flags].map((m) => [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)));

    return {
      asOf: centralClock.format(now),
      at: now,
      range: args.range,
      from,
      to,
      delinquency:
        bookResult === null
          ? null
          : {
              accounts: bookResult.accounts,
              ...money(bookResult.cents),
              buckets: bookResult.buckets.map((b) => ({ bucket: b.bucket, accounts: b.accounts, ...money(b.cents) })),
              asOf: centralClock.format(bookResult.at),
            },
      calls: {
        ...tally,
        connectRate: tally.placed > 0 ? Math.round((tally.connected / tally.placed) * 100) : 0,
        byStatus: statusCounts ?? [],
        flags: flagCounts ?? [],
        perDay: days.map((d) => ({ date: d.slice(5), ...(perDay.get(d) ?? { placed: 0, connected: 0 }) })),
      },
      payments:
        paidResult === null
          ? null
          : {
              count: paidResult.count,
              customers: paidResult.customers,
              ...money(paidResult.cents),
              customerDriven: { count: paidResult.driven.count, ...money(paidResult.driven.cents) },
              perDay: days.map((d) => {
                const day = paidResult.perDay.get(d) ?? { count: 0, cents: 0 };
                return { date: d.slice(5), count: day.count, ...money(day.cents) };
              }),
            },
      unavailable,
    };
  };
}
