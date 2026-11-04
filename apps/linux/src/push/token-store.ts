// Expo push tokens per paired phone: `$XDG_CONFIG_HOME/relay/push-tokens.json` (dir 0700, file
// 0600), beside devices.json. A token is not a secret in the pairing sense, but anyone holding it
// can make the phone buzz, so it gets the same file mode. The assistants a phone muted
// (`push.prefs`) sit beside it in `push-prefs.json`, same mode, and go with the token on
// `push.unregister`.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { PushRegistry } from "../seams";

const TokensFile = z.record(z.string().min(1), z.string().min(1));
type TokensFile = z.infer<typeof TokensFile>;
const PrefsFile = z.record(z.string().min(1), z.array(z.string().min(1)));
type PrefsFile = z.infer<typeof PrefsFile>;

export function defaultPushTokensPath(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "relay", "push-tokens.json");
}

export function defaultPushPrefsPath(): string {
  return join(dirname(defaultPushTokensPath()), "push-prefs.json");
}

export interface PushTokenSource {
  /**
   * Every registered device with its token. With `assistant`, the devices that muted that assistant
   * are left out: every push about an assistant asks for its recipients this way.
   */
  tokens(assistant?: string): ReadonlyMap<string, string>;
}

export class FilePushTokenStore implements PushRegistry, PushTokenSource {
  constructor(
    private readonly path: string = defaultPushTokensPath(),
    private readonly prefsPath: string = join(dirname(path), "push-prefs.json"),
  ) {}

  tokens(assistant?: string): ReadonlyMap<string, string> {
    const all = Object.entries(this.load());
    if (assistant === undefined) return new Map(all);
    const muted = this.loadPrefs();
    return new Map(all.filter(([deviceId]) => !(muted[deviceId] ?? []).includes(assistant)));
  }

  register(deviceId: string, token: string): void {
    const all = this.load();
    if (all[deviceId] === token) return;
    all[deviceId] = token;
    this.persist(this.path, all);
  }

  unregister(deviceId: string): void {
    const all = this.load();
    if (deviceId in all) this.persist(this.path, Object.fromEntries(Object.entries(all).filter(([id]) => id !== deviceId)));
    const prefs = this.loadPrefs();
    if (deviceId in prefs) this.persist(this.prefsPath, Object.fromEntries(Object.entries(prefs).filter(([id]) => id !== deviceId)));
  }

  setMuted(deviceId: string, muted: readonly string[]): void {
    const prefs = this.loadPrefs();
    const next = [...new Set(muted)];
    if (next.length === 0) {
      if (!(deviceId in prefs)) return;
      this.persist(this.prefsPath, Object.fromEntries(Object.entries(prefs).filter(([id]) => id !== deviceId)));
      return;
    }
    if ((prefs[deviceId] ?? []).join("\n") === next.join("\n")) return;
    prefs[deviceId] = next;
    this.persist(this.prefsPath, prefs);
  }

  private load(): TokensFile {
    if (!existsSync(this.path)) return {};
    const parsed = TokensFile.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
    if (!parsed.success) throw new Error(`${this.path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    return parsed.data;
  }

  /** A damaged prefs file mutes nothing: a push the phone did not want beats one it never got. */
  private loadPrefs(): PrefsFile {
    if (!existsSync(this.prefsPath)) return {};
    try {
      const parsed = PrefsFile.safeParse(JSON.parse(readFileSync(this.prefsPath, "utf8")));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  private persist(path: string, all: TokensFile | PrefsFile): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }
}
