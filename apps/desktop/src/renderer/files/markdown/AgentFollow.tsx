import { useEffect, useRef } from 'react'
import { UnstyledButton } from '@mantine/core'
import { IconArrowDown, IconArrowUp } from '@tabler/icons-react'
import { useActorRef, useSelector } from '@xstate/react'
import type { SnapshotFrom } from 'xstate'
import { monaco } from '../monaco-setup'
import type { AgentMark } from '../presence-store'
import { agentFollowMachine } from './agent-follow.machine'

// Runs agent-follow.machine.ts for the rendered Markdown editor: Isaac's typing, clicks and wheel
// in the editor are `isaac.active`; each new agent mark is `agent.edited` with where its line is
// now; marks fading out is `agent.left`. Off screen while he works, a pill says who is editing
// and where; it scrolls there on a click.

type Editor = monaco.editor.IStandaloneCodeEditor
type Snap = SnapshotFrom<typeof agentFollowMachine>

const selectPill = (s: Snap) => (s.matches({ agent: 'offScreen' }) ? s.context.agent : null)

/** Where `line` is against the editor's view: null on screen. */
function sideOf(editor: Editor, line: number): 'above' | 'below' | null {
  const top = editor.getTopForLineNumber(line)
  const scroll = editor.getScrollTop()
  const height = editor.getLayoutInfo().height
  if (top < scroll) return 'above'
  if (top > scroll + height - 32) return 'below'
  return null
}

export function AgentFollow({ editor, marks }: { editor: Editor; marks: readonly AgentMark[] }) {
  const actor = useActorRef(
    agentFollowMachine.provide({
      actions: {
        reveal: (_, { line }) =>
          editor.revealLineInCenterIfOutsideViewport(line, monaco.editor.ScrollType.Smooth),
      },
    }),
  )
  const pill = useSelector(actor, selectPill)
  const seen = useRef(0)

  useEffect(() => {
    const active = (): void => actor.send({ type: 'isaac.active' })
    const dom = editor.getContainerDomNode()
    dom.addEventListener('wheel', active, { passive: true })
    const subs = [editor.onKeyDown(active), editor.onMouseDown(active)]
    return () => {
      dom.removeEventListener('wheel', active)
      for (const s of subs) s.dispose()
    }
  }, [editor, actor])

  useEffect(() => {
    if (marks.length === 0) {
      actor.send({ type: 'agent.left' })
      return
    }
    const latest = marks.reduce((a, b) => (b.seq > a.seq ? b : a))
    if (latest.seq <= seen.current) return
    seen.current = latest.seq
    const line = latest.ranges.at(-1)?.endLine ?? latest.caret.line
    actor.send({
      type: 'agent.edited',
      agent: {
        name: latest.agent.name,
        color: latest.agent.color,
        ...(latest.agent.avatarUrl ? { avatarUrl: latest.agent.avatarUrl } : {}),
        ...(latest.intent ? { intent: latest.intent } : {}),
        line,
      },
      side: sideOf(editor, line),
    })
  }, [marks, editor, actor])

  if (!pill?.side) return null
  const Arrow = pill.side === 'above' ? IconArrowUp : IconArrowDown
  return (
    <UnstyledButton
      className="eva-md-follow"
      data-side={pill.side}
      data-testid="md-follow"
      style={{ '--who': pill.color } as React.CSSProperties}
      onClick={() => actor.send({ type: 'agent.jump' })}
    >
      {pill.avatarUrl ? <img className="eva-agent-avatar" src={pill.avatarUrl} alt="" /> : null}
      <span>
        {pill.name} is editing {pill.side}
      </span>
      <Arrow size={14} stroke={1.75} />
    </UnstyledButton>
  )
}
