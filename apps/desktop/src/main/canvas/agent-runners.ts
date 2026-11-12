import type { AgentRunners } from '@evaos/contract'
import type { CanvasDrive } from './agent-canvas'

type CanvasDriveActionId =
  | 'canvas.open'
  | 'canvas.read'
  | 'canvas.add'
  | 'canvas.edit'
  | 'canvas.move'
  | 'canvas.connect'
  | 'canvas.delete'
  | 'canvas.select'
  | 'canvas.zoom'
  | 'canvas.pan'
  | 'canvas.reply'
  | 'canvas.caption'
  | 'canvas.wait'
  | 'canvas.done'

/** The agent control API's canvas.* drive actions (see agent-canvas.ts), run in main. */
export function canvasRunners(drive: CanvasDrive): Pick<AgentRunners<'main'>, CanvasDriveActionId> {
  return {
    'canvas.open': (p) => drive.open(p),
    'canvas.read': ({ slug, page }) => drive.read(slug, page),
    'canvas.add': (p) => drive.add(p),
    'canvas.edit': (p) => drive.edit(p),
    'canvas.move': (p) => drive.move(p),
    'canvas.connect': (p) => drive.connect(p),
    'canvas.delete': (p) => drive.remove(p),
    'canvas.select': (p) => drive.select(p),
    'canvas.zoom': (p) => drive.view(p),
    'canvas.pan': (p) => drive.view(p),
    'canvas.reply': (p) => drive.reply(p),
    'canvas.caption': ({ slug, text, scope }) => drive.caption(slug, text, scope),
    'canvas.wait': ({ slug, timeoutMs }) => drive.wait(slug, timeoutMs),
    'canvas.done': ({ slug, summary, outcome, scope }) => drive.done(slug, summary, outcome, scope),
  }
}
