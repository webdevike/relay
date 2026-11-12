import { useEffect, useState } from 'react'
import { CodeBlock } from '../../chat/markdown/CodeBlock'
import { useColorScheme } from '../../theme/theme-config'
import { mermaidTheme, nextMermaidId } from './mermaid-render'

type Drawn = { state: 'loading' } | { state: 'ready'; svg: string } | { state: 'failed' }

/**
 * An explainer's diagram, drawn by Mermaid (its own lazy chunk, loaded on first use). A fixed-height
 * placeholder holds the space while it loads; a syntax error shows the source as a code block.
 * Its pointer stays off the board's drag and pan.
 */
export function MermaidBlock({ source }: { source: string }) {
  const scheme = useColorScheme()
  const [drawn, setDrawn] = useState<Drawn>({ state: 'loading' })
  useEffect(() => {
    let live = true
    setDrawn({ state: 'loading' })
    void (async () => {
      try {
        // Dynamic on purpose: Mermaid is large, so it stays its own chunk until a diagram draws.
        const { default: mermaid } = await import('mermaid')
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: mermaidTheme(scheme),
          fontFamily: 'inherit',
        })
        const { svg } = await mermaid.render(nextMermaidId(), source)
        if (live) setDrawn({ state: 'ready', svg })
      } catch {
        if (live) setDrawn({ state: 'failed' })
      }
    })()
    return () => {
      live = false
    }
  }, [source, scheme])
  return (
    <div
      className="eva-cv-mermaid nodrag nopan nowheel"
      data-state={drawn.state}
      data-testid="canvas-mermaid"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {drawn.state === 'ready' ? (
        <div className="eva-cv-mermaid-svg" dangerouslySetInnerHTML={{ __html: drawn.svg }} />
      ) : drawn.state === 'failed' ? (
        <CodeBlock lang="mermaid" code={source} />
      ) : (
        <div className="eva-cv-mermaid-loading">Drawing diagram</div>
      )}
    </div>
  )
}
