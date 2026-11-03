import { useEffect, useState } from 'react'
import { ActionIcon, Button, Kbd, Tooltip, useComputedColorScheme } from '@mantine/core'
import { IconFolder, IconPlus, IconRefresh } from '@tabler/icons-react'
import { BANNERS, BANNER_ROTATE_MS } from './banners'

export interface HeroProps {
  summary: string
  updatedAt: number | null
  reloading: boolean
  entrance: boolean
  onNewTodo: () => void
  onAllWorkspaces: () => void
  onRefresh: () => void
}

function motionOff(): boolean {
  if (document.documentElement.dataset['evaMotion'] === 'off') return true
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function formatUpdated(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export function Hero(p: HeroProps) {
  const scheme = useComputedColorScheme('dark')
  const images = scheme === 'light' ? BANNERS.light : BANNERS.dark
  const [index, setIndex] = useState(0)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (motionOff()) return
    const id = window.setInterval(() => {
      if (document.hidden) return
      setIndex((i) => (i + 1) % images.length)
    }, BANNER_ROTATE_MS)
    return () => window.clearInterval(id)
  }, [images.length])

  return (
    <section
      className={`eva-dash-hero${p.entrance ? ' eva-cue-hero' : ''}`}
      data-testid="dash-hero"
      aria-labelledby="dash-hero-title"
    >
      {failed ? null : (
        <div className="eva-dash-banners" aria-hidden="true">
          {images.map((src, i) => (
            <img
              key={src}
              className="eva-dash-banner"
              src={src}
              alt=""
              data-active={i === index}
              style={{ opacity: i === index ? 1 : 0 }}
              onError={() => setFailed(true)}
            />
          ))}
        </div>
      )}
      <div className="eva-dash-hero-overlay" />
      <div className="eva-dash-hero-content">
        <div className="eva-dash-eyebrow">WELCOME BACK</div>
        <h1 id="dash-hero-title" className="eva-dash-title">
          Dashboard
        </h1>
        <p className="eva-dash-summary" data-testid="dash-summary">
          {p.summary}
        </p>
        <div className="eva-dash-actions">
          <Button
            size="sm"
            leftSection={<IconPlus size={16} />}
            rightSection={<Kbd className="eva-dash-kbd">⌘N</Kbd>}
            data-testid="dash-new-todo"
            onClick={p.onNewTodo}
          >
            New Todo
          </Button>
          <Button
            size="sm"
            variant="default"
            leftSection={<IconFolder size={16} />}
            data-testid="dash-all-workspaces"
            onClick={p.onAllWorkspaces}
          >
            All Workspaces
          </Button>
        </div>
      </div>
      <div className="eva-dash-hero-meta">
        {p.updatedAt === null ? null : (
          <span className="eva-dash-updated" data-testid="dash-updated">
            {`Updated ${formatUpdated(p.updatedAt)}`}
          </span>
        )}
        <Tooltip
          label={
            <span>
              Reload from the Eva repo <Kbd>⌘R</Kbd>
            </span>
          }
        >
          <ActionIcon
            variant="default"
            size={28}
            aria-label="Reload from the Eva repo"
            aria-busy={p.reloading}
            data-testid="dash-refresh"
            data-reloading={p.reloading}
            onClick={p.onRefresh}
          >
            <IconRefresh size={16} className="eva-dash-spin" />
          </ActionIcon>
        </Tooltip>
      </div>
    </section>
  )
}
