// An assistant's model sign-in as the host reports it (`auth`, `failure` on `assistant.agents`):
// what is wrong, which omp profile and provider fix it, and "Sign in again", which runs omp's
// browser sign-in under that profile on this Mac (setup's `ai-login`), or says where to do it when
// this Mac is a thin client of a host on another one.
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import {
  setupProviderOf,
  type Assistant,
  type ProfileAuth,
  type SetupProvider,
  type SigninFix,
} from '@evaos/contract'
import { invoke } from '../ipc'

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Claude',
  'openai-codex': 'ChatGPT',
  openai: 'OpenAI',
}

/** omp provider `provider` as Isaac knows it: `anthropic` is Claude; an unknown id stays itself. */
export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider
}

/** A profile's sign-in to a provider by name: "Claude, personal profile". */
export function signinTitle(s: { provider: string; profile?: string | undefined }): string {
  return `${providerName(s.provider)}, ${s.profile ?? 'default'} profile`
}

/** The state of a profile's sign-in in a few words. */
export const AUTH_STATE_LABEL: Record<ProfileAuth['state'], string> = {
  ok: 'Signed in',
  signed_out: 'Signed out',
  missing: 'Not signed in',
  shared: 'Shared sign-in',
}

/** What a state means when the host gives no `detail`. */
const AUTH_STATE_TEXT: Record<Exclude<ProfileAuth['state'], 'ok'>, string> = {
  signed_out: 'Its sign-in expired, so its turns fail until it signs in again.',
  missing: 'It has never signed in, so its turns fail until it does.',
  shared:
    'It shares a sign-in with another profile, and the first of the two to refresh signs the other out.',
}

export interface Trouble {
  title: string
  text: string
  /** A failed turn (danger), or only a sign-in that will fail the next one (warning). */
  tone: 'danger' | 'warn'
}

/**
 * What is wrong with an agent's model sign-in or its last turn, in its own words: the failed turn
 * the host reports, else its profile's sign-in when that is not ok; null when nothing is.
 */
export function troubleOf(a: Assistant): Trouble | null {
  if (a.failure) return { title: a.failure.title, text: a.failure.text, tone: 'danger' }
  const auth = a.auth
  if (!auth || auth.state === 'ok') return null
  return {
    title: `${signinTitle(auth)}: ${AUTH_STATE_LABEL[auth.state].toLowerCase()}`,
    text: auth.detail ?? AUTH_STATE_TEXT[auth.state],
    tone: 'warn',
  }
}

/** The sign-in that fixes an agent: its failure's fix, else its profile's own sign-in while that is not ok. */
export function fixOf(a: Assistant): SigninFix | null {
  if (a.failure?.fix) return a.failure.fix
  const auth = a.auth
  if (!auth || auth.state === 'ok') return null
  return {
    kind: 'signin',
    provider: auth.provider,
    ...(auth.profile !== undefined && { profile: auth.profile }),
  }
}

/** `omp --profile <p> login <provider>`: the sign-in typed into a terminal on the host's Mac. */
export function loginCommand(fix: SigninFix): string {
  return fix.profile
    ? `omp --profile ${fix.profile} login ${fix.provider}`
    : `omp login ${fix.provider}`
}

/** Identifies a (profile, provider) sign-in: `personal:anthropic`, `default:openai-codex`. */
export function signinKey(fix: { provider: string; profile?: string | undefined }): string {
  return `${fix.profile ?? 'default'}:${fix.provider}`
}

/**
 * How "Sign in again" goes on this Mac: omp's browser sign-in through setup (`run`), the command to
 * copy for a provider setup cannot sign in (`command`), or on the host's Mac when this one is its
 * thin client (`elsewhere`: running it here would sign in this Mac's omp, not the host's).
 */
export type SigninPlan =
  | { kind: 'run'; provider: SetupProvider }
  | { kind: 'command'; command: string }
  | { kind: 'elsewhere'; mac: string }

export function signinPlan(fix: SigninFix, hostMac: string | undefined): SigninPlan {
  if (hostMac !== undefined) return { kind: 'elsewhere', mac: hostMac }
  const provider = setupProviderOf(fix.provider)
  return provider ? { kind: 'run', provider } : { kind: 'command', command: loginCommand(fix) }
}

/** One (profile, provider) sign-in the assistants use, as Settings > Connections lists it. */
export interface ProfileSignin {
  key: string
  title: string
  provider: string
  profile?: string
  state: ProfileAuth['state']
  detail?: string
  account?: string
  /** The assistants on it, by title, in registry order. */
  usedBy: string[]
  fix: SigninFix
}

/**
 * The assistants' sign-ins, one per distinct (profile, provider) their `auth` names, in the order
 * the registry first uses each. Assistants on one profile share its sign-in; any of them reporting
 * a problem marks it.
 */
export function profileSignins(agents: readonly Assistant[]): ProfileSignin[] {
  const rows = new Map<string, ProfileSignin>()
  for (const a of agents) {
    const auth = a.auth
    if (!auth) continue
    const key = signinKey(auth)
    const seen = rows.get(key)
    if (seen) {
      seen.usedBy.push(a.title)
      if (seen.state === 'ok' && auth.state !== 'ok') Object.assign(seen, stateOf(auth))
      continue
    }
    rows.set(key, {
      key,
      title: signinTitle(auth),
      provider: auth.provider,
      ...(auth.profile !== undefined && { profile: auth.profile }),
      ...stateOf(auth),
      usedBy: [a.title],
      fix: {
        kind: 'signin',
        provider: auth.provider,
        ...(auth.profile !== undefined && { profile: auth.profile }),
      },
    })
  }
  return [...rows.values()]
}

function stateOf(auth: ProfileAuth): Pick<ProfileSignin, 'state' | 'detail' | 'account'> {
  return {
    state: auth.state,
    ...(auth.state !== 'ok' && { detail: auth.detail ?? AUTH_STATE_TEXT[auth.state] }),
    ...(auth.account !== undefined && { account: auth.account }),
  }
}

export interface SigninState {
  /** Sign-ins running now, by `signinKey`. */
  busy: Record<string, true>
  /** What the last one said, by `signinKey`: finish in the browser, done, or why it failed. */
  notes: Record<string, string>
}

export const signinStore = createStore<SigninState>(() => ({ busy: {}, notes: {} }))

export function useSignin<T>(selector: (s: SigninState) => T): T {
  return useStore(signinStore, selector)
}

const note = (key: string, text: string): void =>
  signinStore.setState((s) => ({ notes: { ...s.notes, [key]: text } }))

/**
 * Signs `fix`'s profile in to its provider again with omp's browser sign-in (setup `ai-login`
 * with the profile, so omp writes that profile's credential). The host rereads the profile and
 * pushes the agent's new `auth`; the message that failed is not resent. Resolves true once signed in.
 */
export async function signInAgain(fix: SigninFix, provider: SetupProvider): Promise<boolean> {
  const key = signinKey(fix)
  if (signinStore.getState().busy[key]) return false
  signinStore.setState((s) => ({ busy: { ...s.busy, [key]: true } }))
  note(key, 'Finish signing in in your browser.')
  try {
    const r = await invoke('setup.run', {
      runId: `signin-${Date.now()}`,
      run: {
        task: 'ai-login',
        provider,
        ...(fix.profile !== undefined && { profile: fix.profile }),
      },
    })
    const ok = r.ok && r.value.ok
    note(
      key,
      ok
        ? 'Signed in. Send your message again.'
        : (r.ok ? r.value.message : r.error.message) || 'Sign-in failed.',
    )
    return ok
  } finally {
    signinStore.setState((s) => {
      const busy = { ...s.busy }
      delete busy[key]
      return { busy }
    })
  }
}
