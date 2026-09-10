// Paired-device secrets on disk: `$XDG_CONFIG_HOME/relay/devices.json` (dir 0700, file 0600).
// Linux has no universal keychain the way macOS does; the Secret Service API exists on desktop
// sessions but not headless ones, so a mode-locked file in the user's config dir is the boring,
// always-available choice. Each record mirrors KeychainDeviceStore's envelope: secret + name +
// pairedAt.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fromHex, toHex } from "@relay/protocol";
import { z } from "zod";
import type { DeviceStore, PairedDevice } from "./seams";

const DeviceRecord = z.object({
  secretHex: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().min(1),
  pairedAt: z.number().int().nonnegative(),
});
const DevicesFile = z.record(z.string().min(1), DeviceRecord);
type DevicesFile = z.infer<typeof DevicesFile>;

export function defaultDevicesPath(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "relay", "devices.json");
}

export class FileDeviceStore implements DeviceStore {
  constructor(private readonly path: string = defaultDevicesPath()) {}

  secret(deviceId: string): Uint8Array | null {
    const record = this.load()[deviceId];
    return record === undefined ? null : fromHex(record.secretHex);
  }

  save(secret: Uint8Array, deviceId: string, deviceName: string): void {
    const all = this.load();
    all[deviceId] = { secretHex: toHex(secret), name: deviceName, pairedAt: Date.now() };
    this.persist(all);
  }

  forget(deviceId: string): void {
    const all = this.load();
    if (!(deviceId in all)) return;
    this.persist(Object.fromEntries(Object.entries(all).filter(([id]) => id !== deviceId)));
  }

  pairedDevices(): PairedDevice[] {
    return Object.entries(this.load()).map(([id, record]) => ({ id, name: record.name, pairedAt: record.pairedAt }));
  }

  private load(): DevicesFile {
    if (!existsSync(this.path)) return {};
    const parsed = DevicesFile.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
    if (!parsed.success) throw new Error(`${this.path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    return parsed.data;
  }

  private persist(all: DevicesFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
