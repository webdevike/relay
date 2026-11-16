// Read-only share links to one board or one tab of it. Each share is an unguessable token (32
// random bytes, base64url) that `/share/<token>` (share-page.ts) resolves to exactly that board or
// tab; nothing else is reachable from it. Shares live in one JSON file (0600, tmp + rename), read
// once at start. A share outlives a rebuild of its board or tab: it draws again as soon as a board
// (and tab) with that slug (and id) is back, and "gone" until then. Revoking deletes the token.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BoardShare } from "@relay/protocol";
import { z } from "zod";
import { BoardError, type FileBoardStore } from "./store";

const ShareFile = z.array(BoardShare);

const TAILSCALE = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

/**
 * `https://<this machine's MagicDNS name>`, where `tailscale serve` publishes `/share` on the
 * tailnet, read from `tailscale status --json`; null without Tailscale (shares then print only
 * their path).
 */
export function tailnetOrigin(): string | null {
  for (const command of TAILSCALE) {
    try {
      const run = Bun.spawnSync([command, "status", "--json"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      if (run.exitCode !== 0) continue;
      const name = z
        .object({ Self: z.object({ DNSName: z.string().min(1) }) })
        .parse(JSON.parse(run.stdout.toString())).Self.DNSName;
      return `https://${name.replace(/\.$/, "")}`;
    } catch {
      // not installed here, or not signed in
    }
  }
  return null;
}

export class BoardShares {
  private readonly shares = new Map<string, BoardShare>();

  constructor(
    private readonly file: string,
    private readonly boards: FileBoardStore,
    log: (line: string) => void,
  ) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    try {
      for (const share of ShareFile.parse(JSON.parse(text))) this.shares.set(share.token, share);
    } catch (error) {
      log(`boards: ignoring ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The shares of `slug`, oldest first. */
  list(slug: string): BoardShare[] {
    return [...this.shares.values()].filter((share) => share.slug === slug);
  }

  /** A new share of board `slug`, or of its tab `tab`; 404 when either is missing. */
  create(slug: string, tab: string | undefined): BoardShare {
    const board = this.boards.get(slug);
    if (board === null) throw new BoardError(404, `no board ${slug}`);
    if (tab !== undefined && board.tabs?.some((candidate) => candidate.id === tab) !== true)
      throw new BoardError(404, `board ${slug} has no tab ${tab}`);
    const share: BoardShare = {
      token: randomBytes(32).toString("base64url"),
      slug,
      ...(tab === undefined ? {} : { tab }),
      createdAt: new Date().toISOString(),
    };
    this.shares.set(share.token, share);
    this.save();
    return share;
  }

  /** Revokes `token` if it shares `slug`; false when there is no such share. */
  revoke(slug: string, token: string): boolean {
    if (this.shares.get(token)?.slug !== slug) return false;
    this.shares.delete(token);
    this.save();
    return true;
  }

  resolve(token: string): BoardShare | null {
    return this.shares.get(token) ?? null;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify([...this.shares.values()], null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
