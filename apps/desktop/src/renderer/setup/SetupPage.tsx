import { Alert, Progress, Text } from '@mantine/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Place } from '@evaos/shell-core'
import type { SetupDetect, SetupState, SetupStep } from '@evaos/contract'
import { invoke } from '../ipc'
import '../settings/settings.css'
import './setup.css'
import { firstIncomplete } from './run'
import { neighbour, visibleSteps } from './hindsight-state'
import { MemoryStep } from './steps-memory'
import { AiStep, CheckStep, InstallStep, WelcomeStep } from './steps-system'
import { AssistantsStep, HomeStep, HostStep } from './steps-home'
import { DoneStep, PhoneStep } from './steps-finish'
import type { WizardCtx } from './wizard'

const TITLES: Record<SetupStep, string> = {
  welcome: 'Welcome to Relay',
  check: 'Check your Mac',
  install: 'Install what is missing',
  ai: 'Connect AI',
  home: 'Your home base',
  assistants: 'Your assistants',
  hindsight: 'Long-term memory (optional)',
  host: 'Relay Host',
  phone: 'Your iPhone',
  done: 'All set',
}

interface Loaded {
  computerName: string
  defaultRoot: string
  rerun: boolean
  profile: 'eva' | 'starter'
  state: SetupState
}

/** A rerun only re-checks: it never touches the home base or its assistants. */
const RERUN_SKIPS: SetupStep[] = ['home', 'assistants']

/**
 * First-run wizard (also reachable from Settings, Setup). Progress is saved after every step, so a
 * quit resumes at the first step not yet done.
 */
export function SetupPage(_props: { place: Place }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<SetupState>({ done: [] })
  const [step, setStep] = useState<SetupStep>('welcome')
  const [detect, setDetect] = useState<SetupDetect | null>(null)
  const [detectError, setDetectError] = useState<string | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  const recheck = useCallback(async (): Promise<SetupDetect | null> => {
    const r = await invoke('setup.detect', {})
    if (r.ok) {
      setDetect(r.value.detect)
      setDetectError(null)
      return r.value.detect
    }
    setDetectError(r.error.message)
    return null
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [info, app] = await Promise.all([invoke('setup.info', {}), invoke('app.info', {})])
      if (cancelled) return
      if (!info.ok) {
        setError(info.error.message)
        return
      }
      if (info.value.missing.length > 0) {
        setError(
          `Setup files are missing from this build: ${info.value.missing.join(', ')}. Reinstall Relay or rebuild with resources/setup.`,
        )
        return
      }
      const rerun = app.ok && app.value.setupComplete === true
      // A rerun starts at the check; a first run resumes where it stopped.
      const saved: SetupState = rerun ? { done: ['welcome'] } : info.value.state
      setState(saved)
      setStep(rerun ? 'check' : firstIncomplete(saved, app.ok ? app.value.profile : 'starter'))
      setLoaded({
        computerName: info.value.computerName,
        defaultRoot: rerun && app.ok ? app.value.homeRoot : info.value.defaultRoot,
        rerun,
        profile: app.ok ? app.value.profile : 'starter',
        state: saved,
      })
      if (!rerun && firstIncomplete(saved, app.ok ? app.value.profile : 'starter') !== 'welcome')
        void recheck()
    })()
    return () => {
      cancelled = true
    }
  }, [recheck])

  const persist = useCallback((next: SetupState): void => {
    setState(next)
    stateRef.current = next
    void invoke('setup.state.save', { state: next })
  }, [])

  if (error) {
    return (
      <div className="eva-settings" data-testid="setup-page">
        <div className="eva-settings-col">
          <Alert color="red" title="Setup cannot start" data-testid="setup-error">
            {error}
          </Alert>
        </div>
      </div>
    )
  }
  if (!loaded) {
    return (
      <div className="eva-settings" data-testid="setup-page">
        <div className="eva-settings-col">
          <Text c="dimmed">Loading…</Text>
        </div>
      </div>
    )
  }

  const steps = visibleSteps(loaded.profile)
  const index = steps.indexOf(step)
  const skips = loaded.rerun ? RERUN_SKIPS : []
  const ctx: WizardCtx = {
    computerName: loaded.computerName,
    defaultRoot: loaded.defaultRoot,
    rerun: loaded.rerun,
    detect,
    detectError,
    recheck,
    state,
    patch: (change) => persist({ ...stateRef.current, ...change }),
    finish: () => {
      const cur = stateRef.current
      persist({ ...cur, done: cur.done.includes(step) ? cur.done : [...cur.done, step] })
      const next = neighbour(steps, step, 1, skips)
      if (next) setStep(next)
    },
    back: () => {
      const prev = neighbour(steps, step, -1, skips)
      if (prev) setStep(prev)
    },
  }

  return (
    <div className="eva-settings" data-testid="setup-page" data-step={step}>
      <div className="eva-settings-col eva-setup-col">
        <Text size="xs" c="dimmed" fw={600} data-testid="setup-progress-label">
          Step {index + 1} of {steps.length}
        </Text>
        <Progress value={((index + 1) / steps.length) * 100} size="xs" />
        <h1 className="eva-settings-title">{TITLES[step]}</h1>
        {step === 'welcome' ? <WelcomeStep ctx={ctx} /> : null}
        {step === 'check' ? <CheckStep ctx={ctx} /> : null}
        {step === 'install' ? <InstallStep ctx={ctx} /> : null}
        {step === 'ai' ? <AiStep ctx={ctx} /> : null}
        {step === 'home' ? <HomeStep ctx={ctx} /> : null}
        {step === 'assistants' ? <AssistantsStep ctx={ctx} /> : null}
        {step === 'hindsight' ? <MemoryStep ctx={ctx} /> : null}
        {step === 'host' ? <HostStep ctx={ctx} /> : null}
        {step === 'phone' ? <PhoneStep ctx={ctx} /> : null}
        {step === 'done' ? <DoneStep ctx={ctx} /> : null}
      </div>
    </div>
  )
}
