import type { SetupDetect, SetupState } from '@evaos/contract'

/** What every step gets from the page. */
export interface WizardCtx {
  computerName: string
  defaultRoot: string
  /** The wizard was opened again from Settings: nothing relaunches and the steps only re-check. */
  rerun: boolean
  detect: SetupDetect | null
  detectError: string | null
  /** Runs detect.sh again and stores the result. */
  recheck(): Promise<SetupDetect | null>
  state: SetupState
  /** Merges into the saved wizard state (persisted to setup-progress.json). */
  patch(change: Partial<SetupState>): void
  /** Marks the step done and moves to the next one. */
  finish(): void
  back(): void
}
