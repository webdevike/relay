// Expo push tokens per paired phone: `$XDG_CONFIG_HOME/relay/push-tokens.json` (dir 0700, file
// 0600), beside devices.json. A token is not a secret in the pairing sense, but anyone holding it
// can make the phone buzz, so it gets the same file mode.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { PushRegistry } from "../seams";

const TokensFile = z.record(z.string().min(1), z.string().min(1));
type TokensFile = z.infer<typeof TokensFile>;

export function defaultPushTokensPath(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "relay", "push-tokens.json");
}

export interface PushTokenSource {
  /** Every registered device with its token. */
  tokens(): ReadonlyMap<string, string>;
}

export class FilePushTokenStore implements PushRegistry, PushTokenSource {
  constructor(private readonly path: string = defaultPushTokensPath()) {}

  tokens(): ReadonlyMap<string, string> {
    return new Map(Object.entries(this.load()));
  }

  register(deviceId: string, token: string): void {
    const all = this.load();
    if (all[deviceId] === token) return;
    all[deviceId] = token;
    this.persist(all);
  }

  unregister(deviceId: string): void {
    const all = this.load();
    if (!(deviceId in all)) return;
    this.persist(Object.fromEntries(Object.entries(all).filter(([id]) => id !== deviceId)));
  }

  private load(): TokensFile {
    if (!existsSync(this.path)) return {};
    const parsed = TokensFile.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
    if (!parsed.success) throw new Error(`${this.path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    return parsed.data;
  }

  private persist(all: TokensFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
