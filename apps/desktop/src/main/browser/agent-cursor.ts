/**
 * The agent's cursor, drawn inside the page it drives (a native page paints over anything the
 * shell draws, so the cursor can't live in the shell). PageControl.cursor runs CURSOR_SCRIPT in an
 * isolated world: page scripts never see its code or state, only an inert host element
 * (`#relay-agent-cursor`, pointer-events none). The drawing is shell-core's drawAgentCursor, the
 * same one the canvas board uses; called with just the op it covers the page's viewport.
 */
import { drawAgentCursor } from '@evaos/shell-core/agent-cursor'

export { CURSOR_LEAD_MS, type CursorOp } from '@evaos/shell-core/agent-cursor'

/** `function (op, place) { ... }` run in the isolated world (see PageControl.cursor). */
export const CURSOR_SCRIPT = String(drawAgentCursor)
