// The services Relay reads from or signs in to (Settings > Connections, the connections.* agent
// actions): the paired Relay Host, GitHub through gh, Linear through an API key, Slack through
// Claude's connector, and the model sign-ins omp holds. Nothing here returns or logs a secret: a
// Linear key goes in and is only ever reported as "saved". Sign-ins that need Isaac (a browser,
// a code) answer `needs-user` with the deep link to the row in Settings that runs them.
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CONNECTIONS,
  CONNECTION_IDS,
  appLinkFor,
  type ConnectResult,
  type Connection,
  type ConnectionId,
} from '@evaos/contract'
import { RELAY_LINEAR_FILE, linearKey, type LinearKeySource } from '../linear/linear-ipc'

/** Fails with a stable code the agent API passes on. */
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

export interface ConnectionsDeps {
  evaRoot: string
  configDir: string
  /** Live app only: run gh and omp and ask Linear. A test or dev instance reports what files say. */
  probe: boolean
  /** The connected Relay Host as its welcome named it, or null. */
  host(): { name: string; version: string } | null
  /** Runs a CLI to its end (gh, omp) with the app's PATH. */
  run(bin: string, args: string[]): Promise<{ code: number | null; stdout: string }>
  ompBin: string
  /** Starts GitHub's device sign-in: answers its code once gh prints it; `done` when it ends. */
  ghLogin(): Promise<{ code: string; url: string; done: Promise<boolean> }>
  /** Linear's name for the key's owner, or null when Linear refuses the key. */
  linearViewer(key: string): Promise<string | null>
}

const SOURCE_DETAIL: Record<LinearKeySource, string> = {
  env: 'Key from the LINEAR_API_KEY environment variable',
  eva: "Key from Eva's secrets/linear.env",
  relay: "Key saved in Relay's config (Settings > Connections)",
}

/** What Settings > Connections and the connections.* actions read and change. */
export interface Connections {
  /** The connections with their state, read fresh each time (gh and omp answer in well under 1 s). */
  list(): Promise<Connection[]>
  onChange(fn: (rows: Connection[]) => void): () => void
  /** Lists again and tells every listener. */
  changed(): Promise<void>
  /** An agent's connections.add: saves a Linear key it was given, else says what Isaac does. */
  add(id: ConnectionId, secret: string | undefined): Promise<ConnectResult>
  /** Isaac's Connect in Settings: GitHub starts its device sign-in; Linear saves the key. */
  connect(id: ConnectionId, secret: string | undefined): Promise<ConnectResult>
  /** Removes what Relay manages; anything else is refused with where it lives. */
  remove(id: ConnectionId): Promise<void>
}

const linkTo = (id: ConnectionId): string => appLinkFor({ connection: id }).url

const NOT_CHECKED = 'Not checked outside the live app'

export function createConnections(deps: ConnectionsDeps): Connections {
  const listeners = new Set<(rows: Connection[]) => void>()
  let ghPending: { code: string; url: string } | null = null

  const row = (
    id: ConnectionId,
    state: Pick<Connection, 'status' | 'account' | 'detail' | 'canAdd' | 'canRemove'>,
  ): Connection => ({
    id,
    title: CONNECTIONS[id].title,
    kind: CONNECTIONS[id].kind,
    usedBy: CONNECTIONS[id].usedBy,
    link: linkTo(id),
    ...state,
  })

  /** omp's model sign-ins (`omp usage accounts --json`), as detect.sh reads them. */
  const ompProviders = async (): Promise<string[] | null> => {
    const r = await deps.run(deps.ompBin, ['usage', 'accounts', '--json'])
    if (r.code !== 0) return null
    try {
      const parsed = JSON.parse(r.stdout) as { accounts?: Array<{ provider?: unknown }> }
      return (parsed.accounts ?? []).flatMap((a) =>
        typeof a.provider === 'string' && !a.provider.startsWith('mcp_oauth') ? [a.provider] : [],
      )
    } catch {
      return null
    }
  }

  const github = async (): Promise<Connection> => {
    if (ghPending) {
      return row('github', {
        status: 'not-connected',
        account: null,
        detail: `Signing in: enter ${ghPending.code} at ${ghPending.url}`,
        canAdd: true,
        canRemove: false,
      })
    }
    if (!deps.probe) {
      return row('github', {
        status: 'unknown',
        account: null,
        detail: NOT_CHECKED,
        canAdd: true,
        canRemove: false,
      })
    }
    const r = await deps.run('gh', ['api', 'user', '--jq', '.login'])
    const login = r.code === 0 ? r.stdout.trim() : ''
    return row('github', {
      status: login ? 'connected' : 'not-connected',
      account: login || null,
      detail: login ? 'Signed in with gh' : 'gh is not signed in (or not installed)',
      canAdd: !login,
      canRemove: Boolean(login),
    })
  }

  const linear = async (): Promise<Connection> => {
    const found = await linearKey(deps.evaRoot, deps.configDir)
    if (found === null) {
      return row('linear', {
        status: 'not-connected',
        account: null,
        detail: 'No Linear API key',
        canAdd: true,
        canRemove: false,
      })
    }
    const account = deps.probe ? await deps.linearViewer(found.key).catch(() => null) : null
    const refused = deps.probe && account === null
    return row('linear', {
      status: refused ? 'not-connected' : 'connected',
      account,
      detail: refused
        ? `${SOURCE_DETAIL[found.source]}; Linear refused it`
        : SOURCE_DETAIL[found.source],
      canAdd: refused || found.source === 'relay',
      canRemove: found.source === 'relay',
    })
  }

  const list = async (): Promise<Connection[]> => {
    const host = deps.host()
    const providers = deps.probe ? await ompProviders() : null
    const ai = (id: 'anthropic' | 'openai'): Connection => {
      const signed = providers?.filter((p) => p.startsWith(id)) ?? []
      return row(id, {
        status: providers === null ? 'unknown' : signed.length > 0 ? 'connected' : 'not-connected',
        account: null,
        detail:
          providers === null
            ? deps.probe
              ? 'omp could not say'
              : NOT_CHECKED
            : signed.length > 0
              ? `Signed in to omp (${signed.join(', ')})`
              : 'Not signed in to omp',
        canAdd: true,
        canRemove: false,
      })
    }
    const rows: Record<ConnectionId, Connection> = {
      'relay-host': row('relay-host', {
        status: host ? 'connected' : 'not-connected',
        account: host ? host.name : null,
        detail: host ? `Relay Host ${host.version}` : 'No Relay Host connected',
        canAdd: !host,
        canRemove: false,
      }),
      github: await github(),
      linear: await linear(),
      slack: row('slack', {
        status: 'unknown',
        account: null,
        detail: "Read through Claude's Slack connector (claude.ai > Settings > Connectors)",
        canAdd: false,
        canRemove: false,
      }),
      anthropic: ai('anthropic'),
      openai: ai('openai'),
    }
    return CONNECTION_IDS.map((id) => rows[id])
  }

  const changed = async (): Promise<void> => {
    if (listeners.size === 0) return
    const rows = await list()
    for (const l of listeners) l(rows)
  }

  const saveLinear = async (secret: string): Promise<ConnectResult> => {
    const account = deps.probe ? await deps.linearViewer(secret).catch(() => null) : null
    if (deps.probe && account === null) {
      fail('key-refused', 'Linear refused that key; nothing was saved')
    }
    const file = path.join(deps.configDir, RELAY_LINEAR_FILE)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, `LINEAR_API_KEY=${secret}\n`, { mode: 0o600 })
    fs.chmodSync(file, 0o600)
    void changed()
    return { status: 'connected', id: 'linear', account }
  }

  /** The step only Isaac can take for `id`, with the link to where he takes it. */
  const needsUser = (id: ConnectionId): ConnectResult => {
    const link = linkTo(id)
    switch (id) {
      case 'github':
        return {
          status: 'needs-user',
          id,
          link,
          step: 'Click Connect on GitHub in Settings > Connections, then enter the code it shows on github.com.',
        }
      case 'linear':
        return {
          status: 'needs-user',
          id,
          link,
          step: 'Paste a Linear API key (Linear > Settings > Security & access > New API key) into Linear in Settings > Connections.',
          url: 'https://linear.app/settings/account/security',
        }
      case 'slack':
        return {
          status: 'needs-user',
          id,
          link,
          step: "Turn on Slack in Claude's connectors (claude.ai > Settings > Connectors); Reviews reads Slack through it.",
          url: 'https://claude.ai/settings/connectors',
        }
      case 'relay-host':
        return {
          status: 'needs-user',
          id,
          link: appLinkFor({ page: 'setup' }).url,
          step: 'Run Setup and its Relay Host step, which installs and pairs the host on this Mac.',
        }
      default:
        return {
          status: 'needs-user',
          id,
          link,
          step: `Click Sign in on ${CONNECTIONS[id].title} in Settings > Connections and finish in the browser.`,
        }
    }
  }

  return {
    list,
    onChange(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    changed,

    async add(id, secret) {
      if (secret !== undefined) return saveLinear(secret)
      const now = (await list()).find((c) => c.id === id)!
      if (now.status === 'connected') return { status: 'connected', id, account: now.account }
      return needsUser(id)
    },

    async connect(id, secret) {
      if (id === 'linear' && secret !== undefined) return saveLinear(secret)
      if (id !== 'github') return needsUser(id)
      if (!deps.probe) fail('not-live', 'GitHub sign-in runs only in the live app')
      const login = await deps.ghLogin()
      ghPending = { code: login.code, url: login.url }
      void changed()
      void login.done.then(() => {
        ghPending = null
        void changed()
      })
      return {
        ...needsUser('github'),
        step: `Enter ${login.code} at ${login.url} (opened in your browser).`,
        url: login.url,
        code: login.code,
      }
    },

    async remove(id) {
      if (id === 'linear') {
        const found = await linearKey(deps.evaRoot, deps.configDir)
        if (found === null) fail('not-connected', 'Linear is not connected')
        if (found.source !== 'relay') {
          fail('not-removable', `${SOURCE_DETAIL[found.source]}; Relay only removes a key it saved`)
        }
        fs.rmSync(path.join(deps.configDir, RELAY_LINEAR_FILE), { force: true })
      } else if (id === 'github') {
        if (!deps.probe) fail('not-live', 'GitHub sign-out runs only in the live app')
        const r = await deps.run('gh', ['auth', 'logout', '--hostname', 'github.com'])
        if (r.code !== 0) fail('gh-failed', 'gh auth logout failed')
      } else {
        const how: Record<string, string> = {
          'relay-host': 'Unpair it on the host (Relay Host > Devices)',
          slack: "Turn it off in Claude's connectors (claude.ai > Settings > Connectors)",
          anthropic: 'Sign out with `omp logout anthropic` in a terminal',
          openai: 'Sign out with `omp logout openai` in a terminal',
        }
        fail('not-removable', `${CONNECTIONS[id].title} is not removed from Relay. ${how[id]}.`)
      }
      void changed()
    },
  }
}

/** The one-time code and device page in gh's `auth login --web` output, once both are printed. */
export function parseGhDeviceCode(output: string): { code: string; url: string } | null {
  const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(output)?.[1]
  if (!code) return null
  const url =
    /(https:\/\/github\.com\/login\/device)\b/.exec(output)?.[1] ??
    'https://github.com/login/device'
  return { code, url }
}
