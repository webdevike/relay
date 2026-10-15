import type { ReactNode } from 'react'
import { AccessPicker } from './AccessPicker'
import { AccountPicker } from './AccountPicker'
import { ContextRing } from './ContextRing'
import { ModelPicker } from './ModelPicker'
import type { LaunchControls } from './useLaunchState'
import { useChatStore } from '../chat-store'

/**
 * The composer's toolbar row, left to right: attach, model, access, account (unsent omp chats
 * only), spacer, context ring, then the actions (Stop, Send) the composer passes in.
 */
export function Toolbar({
  paneId,
  disabled,
  launch,
  attach,
  children,
}: {
  paneId: string
  disabled: boolean
  launch: LaunchControls
  attach: ReactNode
  children: ReactNode
}) {
  const tokens = useChatStore((s) => s.panes[paneId]?.meta.contextTokens ?? null)
  const window = useChatStore((s) => s.panes[paneId]?.contextWindow ?? null)
  // Closed (omp exited or was closed) or starting a new process: nothing to switch yet.
  const stopped = useChatStore((s) => s.panes[paneId]?.stopped ?? false)
  const off = disabled || stopped || launch.busy
  const { state } = launch
  return (
    <>
      <div className="eva-composer-toolbar">
        {attach}
        <ModelPicker
          state={state}
          models={launch.models}
          disabled={off}
          onChange={(p) => void launch.apply(p)}
        />
        <AccessPicker state={state} disabled={off} onChange={(p) => void launch.apply(p)} />
        {state && state.unsent && state.harness === 'omp' ? (
          <AccountPicker state={state} disabled={off} onChange={(p) => void launch.apply(p)} />
        ) : null}
        <div className="eva-composer-spacer" />
        <ContextRing tokens={tokens} window={window} />
        {children}
      </div>
      {launch.error ? (
        <div className="eva-composer-notice" role="alert" data-testid="composer-launch-error">
          {launch.error}
        </div>
      ) : null}
    </>
  )
}
