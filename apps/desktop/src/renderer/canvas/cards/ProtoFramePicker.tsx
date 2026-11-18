/**
 * A component card's frame in its header: the surface's name and size, and on click the presets
 * (each real Relay surface at its measured size) plus a custom width and height. Picking one
 * resizes the card's artboard; the board saves it like any edit.
 */
import { Button, Group, NumberInput, Stack, Text, UnstyledButton } from '@mantine/core'
import { IconCheck } from '@tabler/icons-react'
import { useState, type MouseEvent } from 'react'
import {
  FRAME_MAX,
  FRAME_MIN,
  FRAME_PRESETS,
  customFrame,
  type Frame,
  type FramePreset,
} from '@relay/widget-runtime/systems'
import { EvaPopover } from '../../overlay/EvaPopover'

const stop = (e: MouseEvent): void => e.stopPropagation()
const PRESETS = Object.entries(FRAME_PRESETS) as [
  FramePreset,
  (typeof FRAME_PRESETS)[FramePreset],
][]

export function ProtoFramePicker({
  id,
  frame,
  onPick,
}: {
  id: string
  frame: Frame
  onPick: (frame: string) => void
}) {
  const [opened, setOpened] = useState(false)
  const [w, setW] = useState<number | string>(frame.w)
  const [h, setH] = useState<number | string>(frame.h)
  const pick = (value: string): void => {
    setOpened(false)
    onPick(value)
  }
  const cw = Number(w)
  const ch = Number(h)
  const customOk =
    Number.isInteger(cw) &&
    Number.isInteger(ch) &&
    cw >= FRAME_MIN.w &&
    cw <= FRAME_MAX.w &&
    ch >= FRAME_MIN.h &&
    ch <= FRAME_MAX.h
  return (
    <EvaPopover
      opened={opened}
      onChange={(o) => {
        setOpened(o)
        if (o) {
          setW(frame.w)
          setH(frame.h)
        }
      }}
      position="bottom-start"
      width={260}
    >
      <EvaPopover.Target>
        <button
          type="button"
          className="eva-cv-pill-btn nodrag nopan eva-cv-proto-frame-btn"
          data-testid={`canvas-proto-frame-${id}`}
          data-frame={frame.preset}
          title="The surface this card is designed for, at its real size"
          onPointerDown={stop}
          onClick={(e) => {
            e.stopPropagation()
            setOpened((o) => !o)
          }}
        >
          <span>{frame.label}</span>
          <span className="eva-cv-proto-meta">
            {frame.w} &times; {frame.h}
          </span>
        </button>
      </EvaPopover.Target>
      <EvaPopover.Dropdown
        data-testid={`canvas-proto-frames-${id}`}
        onPointerDown={stop}
        className="nodrag nopan nowheel"
      >
        <Stack gap={2}>
          {PRESETS.map(([preset, f]) => (
            <UnstyledButton
              key={preset}
              className="eva-cv-frame-row"
              data-active={preset === frame.preset || undefined}
              data-testid={`canvas-proto-frame-pick-${preset}`}
              onClick={() => pick(preset)}
            >
              <span className="eva-cv-frame-check">
                {preset === frame.preset ? <IconCheck size={12} stroke={2} aria-hidden /> : null}
              </span>
              <span className="eva-cv-frame-name">{f.label}</span>
              <span className="eva-cv-frame-size">
                {f.w} &times; {f.h}
              </span>
            </UnstyledButton>
          ))}
        </Stack>
        <Text size="xs" c="dimmed" mt="sm" mb={4}>
          Custom size
        </Text>
        <Group gap="xs" wrap="nowrap" align="flex-end">
          <NumberInput
            size="xs"
            aria-label="Width"
            value={w}
            onChange={setW}
            min={FRAME_MIN.w}
            max={FRAME_MAX.w}
            allowDecimal={false}
            hideControls
            data-testid={`canvas-proto-frame-w-${id}`}
          />
          <Text size="xs" c="dimmed" pb={6}>
            &times;
          </Text>
          <NumberInput
            size="xs"
            aria-label="Height"
            value={h}
            onChange={setH}
            min={FRAME_MIN.h}
            max={FRAME_MAX.h}
            allowDecimal={false}
            hideControls
            data-testid={`canvas-proto-frame-h-${id}`}
          />
          <Button
            size="xs"
            variant="default"
            disabled={!customOk}
            onClick={() => pick(customFrame(cw, ch))}
            data-testid={`canvas-proto-frame-apply-${id}`}
          >
            Set
          </Button>
        </Group>
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}
