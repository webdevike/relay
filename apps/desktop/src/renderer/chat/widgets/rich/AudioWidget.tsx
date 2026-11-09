import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Button, Group, Slider, Stack, Text } from '@mantine/core'
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react'
import type { AudioSpec } from '@evaos/chat-core/widget'
import { mediaUrl } from '../media-url'
import { WidgetTitle, clock } from './parts'
import { mediaErrorText, useRenderFailure } from '../render-report'

export const SPEEDS = [1, 1.25, 1.5, 1.75, 2] as const
/** The speed pill's choice, shared by every clip. */
export const SPEED_KEY = 'eva.widget.audioSpeed'

function savedSpeed(): number {
  try {
    const n = Number(localStorage.getItem(SPEED_KEY))
    return (SPEEDS as readonly number[]).includes(n) ? n : 1
  } catch {
    return 1
  }
}

/** The speed after `speed`, wrapping from 2x back to 1x. */
export function nextSpeed(speed: number): number {
  const i = (SPEEDS as readonly number[]).indexOf(speed)
  return SPEEDS[(i + 1) % SPEEDS.length]!
}

/**
 * Inline player (widgets.rs audio): play/pause, a seekable bar, elapsed/total time, and a speed
 * pill cycling 1x to 2x (pitch-corrected) that every clip remembers.
 */
export function AudioWidget({ spec }: { spec: AudioSpec }) {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [speed, setSpeed] = useState(savedSpeed)
  const [failed, setFailed] = useState(false)
  const report = useRenderFailure()

  useEffect(() => {
    const el = audio.current
    if (!el) return
    el.preservesPitch = true
    el.playbackRate = speed
  }, [speed])

  const toggle = (): void => {
    const el = audio.current
    if (!el) return
    if (el.paused) void el.play().catch(() => setPlaying(false))
    else el.pause()
  }
  const cycle = (): void => {
    const next = nextSpeed(speed)
    setSpeed(next)
    try {
      localStorage.setItem(SPEED_KEY, String(next))
    } catch {
      // Storage off: the speed still applies to this clip.
    }
  }
  const known = Number.isFinite(duration) && duration > 0
  const end = known ? duration : 1

  return (
    <Stack gap="xs" data-testid="widget-audio">
      {spec.title !== undefined ? <WidgetTitle>{spec.title}</WidgetTitle> : null}
      <audio
        ref={audio}
        src={mediaUrl(spec.src)}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          setDuration(e.currentTarget.duration)
          e.currentTarget.playbackRate = speed
        }}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onError={(e) => {
          setFailed(true)
          report('audio', spec.src, mediaErrorText('audio', e.currentTarget))
        }}
      />
      {failed ? (
        <Text size="xs" c="dimmed">
          Couldn&apos;t load audio
        </Text>
      ) : (
        <Group gap="sm" wrap="nowrap">
          <ActionIcon
            variant="filled"
            radius="xl"
            size="lg"
            aria-label={playing ? 'Pause' : 'Play'}
            onClick={toggle}
          >
            {playing ? <IconPlayerPauseFilled size={16} /> : <IconPlayerPlayFilled size={16} />}
          </ActionIcon>
          <Slider
            className="eva-w-audio-seek"
            aria-label="Seek"
            size="sm"
            min={0}
            max={end}
            step={0.1}
            value={Math.min(time, end)}
            label={null}
            disabled={!known}
            onChange={(t) => {
              setTime(t)
              if (audio.current) audio.current.currentTime = t
            }}
          />
          <Text size="xs" c="dimmed" className="eva-w-time">
            {clock(time)} / {clock(duration)}
          </Text>
          <Button
            size="compact-xs"
            variant="default"
            radius="xl"
            aria-label="Playback speed"
            onClick={cycle}
          >
            {speed}x
          </Button>
        </Group>
      )}
    </Stack>
  )
}
