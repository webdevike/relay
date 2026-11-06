// Finding the local Relay host and pairing with it, ported from relay.rs (config_dir, serve_port,
// device_secret). Relay pairs a phone with a PIN it prints in its own log. This app runs as the
// same user on the same Mac, so it adds itself to Relay's paired devices file instead (the record a
// PIN pairing writes, read by Relay on every connection) and then answers Relay's challenge like any
// paired device.
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import type { ConfigStore } from '../config-store'
import { DEVICE_ID, DEVICE_NAME } from './feed'

/** Relay's config folder: `$XDG_CONFIG_HOME/relay`, else `~/.config/relay`. */
export function relayConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  const base = env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : path.join(home, '.config')
  return path.join(base, 'relay')
}

const ServeSchema = z.object({
  port: z.number().int().min(1).max(65535),
  controlToken: z.string().min(1).optional(),
})

function readServe(configDir: string): z.infer<typeof ServeSchema> | null {
  try {
    const r = ServeSchema.safeParse(
      JSON.parse(fs.readFileSync(path.join(configDir, 'serve.json'), 'utf8')),
    )
    return r.success ? r.data : null
  } catch {
    return null
  }
}

/** The port the running host left in `serve.json`, or null when there is none. */
export function servePort(configDir: string): number | null {
  return readServe(configDir)?.port ?? null
}

/**
 * The bearer token the running host left in `serve.json` (0600): every state-changing loopback
 * route (`/query`, `/skills`, `/canvas/sessions`, ...) requires it. Null when there is no host.
 */
export function serveToken(configDir: string): string | null {
  return readServe(configDir)?.controlToken ?? null
}

/** The `Authorization` header for a loopback write to the host, or nothing without a token. */
export function bearer(token: string | null): Record<string, string> {
  return token === null ? {} : { authorization: `Bearer ${token}` }
}

const DevicesSchema = z.record(z.string(), z.unknown())
const DeviceSchema = z.object({ secretHex: z.string().regex(/^[0-9a-fA-F]{64}$/) })

/**
 * This app's secret in Relay's `devices.json`, adding it there first if it is not listed. Throws
 * when the file cannot be read or parsed (it is never overwritten then) or cannot be written.
 */
export function deviceSecret(configDir: string, now: () => number = Date.now): Buffer {
  const file = path.join(configDir, 'devices.json')
  let devices: Record<string, unknown>
  try {
    devices = DevicesSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    devices = {}
  }
  const known = DeviceSchema.safeParse(devices[DEVICE_ID])
  if (known.success) return Buffer.from(known.data.secretHex, 'hex')
  const secret = randomBytes(32)
  devices[DEVICE_ID] = { secretHex: secret.toString('hex'), name: DEVICE_NAME, pairedAt: now() }
  // Written the way Relay writes it: owner-only, swapped in whole.
  fs.mkdirSync(configDir, { recursive: true })
  const tmp = `${file}.${DEVICE_ID}-tmp`
  fs.writeFileSync(tmp, JSON.stringify(devices, null, 2), { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file)
  return secret
}

/** A Relay Host on another Mac (over Tailscale), from `relay-remote.json` or EVAOS_RELAY_REMOTE. */
export interface RelayRemote {
  host: string
  port: number
}

/** The app config file naming the remote host and holding its pairing. */
export const REMOTE_FILE = 'relay-remote.json'

/** `host:port` as a URL authority (IPv6 bracketed); also the paired host's id, like mobile's. */
export function remoteAuthority(r: RelayRemote): string {
  return r.host.includes(':') ? `[${r.host}]:${r.port}` : `${r.host}:${r.port}`
}

/** This Mac's id on a remote host: unlike the local one, several Macs may pair with one host. */
export function remoteDeviceId(hostname: string): string {
  return `${DEVICE_ID}-${hostname}`
}

const PairedSchema = z.object({ id: z.string(), secretHex: DeviceSchema.shape.secretHex })

/**
 * The secret a PIN pairing gave this app for `remote`, kept in app config as mobile's `PairedHost`
 * (`{id: 'host:port', secretHex}`). The host's own `devices.json` is never touched.
 */
export function remoteSecretStore(config: ConfigStore, remote: RelayRemote) {
  const id = remoteAuthority(remote)
  return {
    secret(): Uint8Array | null {
      const p = PairedSchema.safeParse(
        config.readJson<{ paired?: unknown }>(REMOTE_FILE, {}).paired,
      )
      return p.success && p.data.id === id ? Buffer.from(p.data.secretHex, 'hex') : null
    },
    save(secret: Uint8Array): void {
      const paired = { id, secretHex: Buffer.from(secret).toString('hex') }
      // The file holds the pairing secret: owner-only, like Relay's own devices.json.
      config.writeJson(REMOTE_FILE, { ...config.readForMerge(REMOTE_FILE), paired }, 0o600)
    },
  }
}
