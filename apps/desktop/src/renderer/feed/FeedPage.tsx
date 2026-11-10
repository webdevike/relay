import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Button, Tooltip } from '@mantine/core'
import {
  IconBookmark,
  IconBookmarkFilled,
  IconExternalLink,
  IconHeart,
  IconHeartFilled,
  IconRefresh,
  IconX,
} from '@tabler/icons-react'
import type { FeedItemDto } from '@evaos/contract'
import type { Place } from '@evaos/shell-core'
import { openLink } from '../navigation/open-link'
import { registerReloader } from '../reload/reload'
import { loadFeed, refreshFeed, signalItem, useFeed } from './feed-store'
import './feed.css'

function ago(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000))
  if (m < 60) return `${Math.max(m, 1)}m`
  if (m < 60 * 24) return `${Math.round(m / 60)}h`
  return `${Math.round(m / 1440)}d`
}

function Media({ item }: { item: FeedItemDto }) {
  const video = useRef<HTMLVideoElement>(null)
  if (!item.image && !item.video) return null
  return (
    <button
      type="button"
      className="eva-feed-media"
      aria-label={`Open ${item.title}`}
      onClick={() => openLink(item.url, { reviews: false })}
      onMouseEnter={() => void video.current?.play().catch(() => {})}
      onMouseLeave={() => video.current?.pause()}
    >
      {item.image && <img src={item.image} alt="" loading="lazy" referrerPolicy="no-referrer" />}
      {item.video && (
        <video ref={video} src={item.video} muted loop playsInline preload="none" />
      )}
    </button>
  )
}

function FeedCard({ item }: { item: FeedItemDto }) {
  const action = useFeed((s) => s.acted[item.id])
  return (
    <article className="eva-feed-card" data-testid="feed-card">
      <header className="eva-feed-meta">
        <span className="eva-feed-source">{item.source}</span>
        {item.tag && <span>{item.tag}</span>}
        {item.process && <span className="eva-feed-process">process</span>}
        <span>{ago(item.ts)}</span>
        {item.meta && <span>{item.meta}</span>}
      </header>
      <Media item={item} />
      <h3 className="eva-feed-title">
        <button type="button" onClick={() => openLink(item.url, { reviews: false })}>
          {item.title}
        </button>
      </h3>
      {item.why && <p className="eva-feed-why">{item.why}</p>}
      <footer className="eva-feed-actions">
        <Tooltip label="Like">
          <ActionIcon
            variant="subtle"
            color={action === 'like' ? 'red' : 'gray'}
            aria-label="Like"
            aria-pressed={action === 'like'}
            onClick={() => signalItem(item, 'like')}
          >
            {action === 'like' ? <IconHeartFilled size={18} /> : <IconHeart size={18} />}
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Save">
          <ActionIcon
            variant="subtle"
            color={action === 'save' ? 'blue' : 'gray'}
            aria-label="Save"
            aria-pressed={action === 'save'}
            onClick={() => signalItem(item, 'save')}
          >
            {action === 'save' ? <IconBookmarkFilled size={18} /> : <IconBookmark size={18} />}
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Skip">
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="Skip"
            onClick={() => signalItem(item, 'skip')}
          >
            <IconX size={18} />
          </ActionIcon>
        </Tooltip>
        <span className="eva-feed-spacer" />
        <Tooltip label="Open">
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="Open"
            onClick={() => openLink(item.url, { reviews: false })}
          >
            <IconExternalLink size={18} />
          </ActionIcon>
        </Tooltip>
      </footer>
    </article>
  )
}

export function FeedPage(_props: { place: Place }) {
  const items = useFeed((s) => s.items)
  const acted = useFeed((s) => s.acted)
  const sources = useFeed((s) => s.sources)
  const error = useFeed((s) => s.error)
  const refreshing = useFeed((s) => s.refreshing)

  useEffect(() => {
    void loadFeed()
    return registerReloader('feed', loadFeed, [])
  }, [])

  const [tag, setTag] = useState<string | null>(null)
  const live = (items ?? []).filter((i) => acted[i.id] !== 'skip')
  const tags = [...new Set(live.flatMap((i) => (i.tag ? [i.tag] : [])))].sort()
  const visible = live.filter((i) => tag === null || i.tag === tag)
  const names = Object.keys(sources).sort()

  return (
    <div className="eva-feed-col">
      <div className="eva-feed-head">
        <h1 className="eva-feed-heading">Feed</h1>
        <span className="eva-feed-spacer" />
        <Button
          size="xs"
          variant="default"
          leftSection={<IconRefresh size={14} />}
          loading={refreshing}
          onClick={() => void refreshFeed()}
        >
          Refresh
        </Button>
      </div>
      {tags.length > 0 && (
        <div className="eva-feed-chips" role="toolbar" aria-label="Filter by interest">
          {[null, ...tags].map((t) => (
            <Button
              key={t ?? 'all'}
              size="compact-xs"
              radius="xl"
              variant={tag === t ? 'filled' : 'default'}
              onClick={() => setTag(t)}
            >
              {t ?? 'all'}
            </Button>
          ))}
        </div>
      )}
      {error && <p className="eva-feed-note">Could not read work/discovery-feed/feed.json.</p>}
      {items && visible.length === 0 && !error && (
        <p className="eva-feed-note">
          Nothing here yet. Press Refresh, or run bun work/discovery-feed/fetch.ts.
        </p>
      )}
      {visible.map((item) => (
        <FeedCard key={item.id} item={item} />
      ))}
      {names.length > 0 && (
        <details className="eva-feed-sources">
          <summary>Sources</summary>
          <ul>
            {names.map((n) => (
              <li key={n}>
                <span>{n}</span>
                <span className="eva-feed-source-state">
                  {sources[n].ok ? `${sources[n].count ?? 0} items` : (sources[n].error ?? 'failed')}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
