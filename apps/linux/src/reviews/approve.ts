// Approve on an eCard auto-work draft PR (ports Relay Desktop's main/reviews/approve.ts, which cannot
// see these files on a laptop): the button shows only while the ticket's ledger on this host
// (<agentHome>/work/items/ENG-*.md) is at "9 PR (draft)" with move isaac, and tapping it hands one
// line to Astra's main thread. Astra runs ready.ts; the host never does.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewApprove } from "@relay/protocol";

/** Written by jobs/astra-auto-work when it opens a ledger (ledgerField / Decisions line). */
const AUTO_WORK_MARK = "auto-work: opened by jobs/astra-auto-work";

function field(text: string, name: string): string {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const m = new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(front);
  return (m?.[1] ?? "").trim();
}

/** What ready.ts approve needs to know about its auto-work watch; the loop starts from the draft state. */
export interface ApproveFacts {
  /** The ticket's self-review loop (auto-work.json `ready`), when one was ever requested. */
  readonly loop: { readonly running: boolean; readonly endedAt: string | null } | null;
  /** When Isaac's approve for this ledger state was handed to Astra (epoch ms). */
  readonly sentAt: number | null;
}

/** The ENG key of the auto-work ledger whose draft PR is `prUrl` and which waits on Isaac's OK, else null. */
export function approvableKey(ledgers: readonly { readonly key: string; readonly text: string }[], prUrl: string): string | null {
  for (const { key, text } of ledgers) {
    if (field(text, "pr") !== prUrl) continue;
    if (field(text, "stage") !== "9 PR (draft)" || field(text, "move") !== "isaac") continue;
    if (!text.includes(AUTO_WORK_MARK)) continue;
    if (!/^ENG-\d+$/.test(key) || field(text, "key") !== key) continue;
    return key;
  }
  return null;
}

/** ready: tap allowed; sent: handed to Astra, wait for the ledger to move; running: the loop already started. */
export function approveState(f: ApproveFacts): ReviewApprove["state"] {
  if (f.loop?.running === true) return "running";
  if (f.sentAt !== null) {
    // A loop that ended after the hand-off (escalated or failed) means Isaac may approve again.
    const ended = f.loop?.endedAt !== null && f.loop?.endedAt !== undefined ? Date.parse(f.loop.endedAt) : NaN;
    if (Number.isNaN(ended) || ended < f.sentAt) return "sent";
  }
  return "ready";
}

/** The line Astra acts on; she runs ready.ts, never the host. */
export function approveLine(key: string): string {
  return `Approve request: Isaac approved the auto-work draft PR for ${key} in Relay Reviews. Run \`bun jobs/astra-auto-work/scripts/ready.ts ${key} approve\` from /Users/ike/Eva and report what it printed.`;
}

export function readLedgers(evaRoot: string): { key: string; text: string }[] {
  const dir = join(evaRoot, "work", "items");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { key: string; text: string }[] = [];
  for (const name of names) {
    const key = /^(ENG-\d+)\.md$/.exec(name)?.[1];
    if (key === undefined) continue;
    try {
      out.push({ key, text: readFileSync(join(dir, name), "utf8") });
    } catch {
      // A ledger mid-write: skip it this read.
    }
  }
  return out;
}

/** The loop state of `key` from Astra's auto-work.json, or null. */
export function readLoop(evaRoot: string, key: string): ApproveFacts["loop"] {
  try {
    const state = JSON.parse(readFileSync(join(evaRoot, "work", "eva", "agents", "astra", "auto-work.json"), "utf8")) as {
      tickets?: Record<string, { ready?: { outcome?: string; endedAt?: string } }>;
    };
    const ready = state.tickets?.[key]?.ready;
    if (ready === undefined) return null;
    return { running: !ready.outcome, endedAt: ready.endedAt ?? null };
  } catch {
    return null;
  }
}
