import { useScopeBadges } from './scope'
import './workspace-dot.css'

/**
 * A quiet dot on a sidebar row while an agent changed that workspace (opened a page, a file, a
 * tab) and Isaac has not looked yet. Its tooltip says what; it goes when he opens the workspace.
 */
export function WorkspaceDot({ ws, testId }: { ws: string; testId: string }) {
  const badge = useScopeBadges()[ws]
  if (!badge) return null
  return <span className="eva-ws-dot" data-testid={testId} title={badge} aria-label={badge} />
}
