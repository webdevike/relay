import { lazy, Suspense, useState } from 'react'
import { Tooltip, UnstyledButton } from '@mantine/core'
import { IconStack2 } from '@tabler/icons-react'
import { useContextStore } from '../context/context-store'
import { EvaPopover } from '../overlay'
import '../context/context.css'
import './artifacts.css'

// The panel loads the first time the button opens.
const ArtifactsPanel = lazy(() =>
  import('./ArtifactsPanel').then((m) => ({ default: m.ArtifactsPanel })),
)

/**
 * The header's Artifacts button on an assistant's page: icon only, a small accent dot while any of
 * its subagents, jobs or auto-work run. It opens an overlay anchored to it with this assistant's
 * artifacts (the Subagents tab lists what runs first).
 */
export function ArtifactsButton({ agent }: { agent: string }) {
  const [open, setOpen] = useState(false)
  // Main reads one running flag for the assistant (subagent transcripts, its sessions, auto-work).
  const busy = useContextStore((s) => {
    const dot = s.snapshot?.kind === 'assistant' ? s.snapshot.button.dot : null
    return dot === 'running' || dot === 'needs'
  })
  return (
    <EvaPopover
      opened={open}
      onChange={setOpen}
      position="bottom-end"
      width={440}
      testid="artifacts-button-target"
    >
      <EvaPopover.Target>
        <Tooltip
          label={busy ? 'Artifacts, running' : 'Artifacts'}
          position="bottom"
          openDelay={400}
          disabled={open}
        >
          <UnstyledButton
            className="eva-header-btn eva-ctx-btn"
            data-testid="artifacts-button"
            data-open={open ? 'true' : undefined}
            data-busy={busy ? 'true' : undefined}
            aria-label="Artifacts"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <IconStack2 size={15} stroke={1.5} aria-hidden />
            {busy ? <span className="eva-ctx-dot" data-dot="active" aria-hidden /> : null}
          </UnstyledButton>
        </Tooltip>
      </EvaPopover.Target>
      <EvaPopover.Dropdown>
        <div className="eva-art-pop" data-testid="artifacts-popover">
          <Suspense fallback={null}>
            <ArtifactsPanel
              hidden={false}
              scope={`page:agent:${agent}`}
              onNavigate={() => setOpen(false)}
            />
          </Suspense>
        </div>
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}
