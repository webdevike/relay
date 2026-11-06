import { useState } from 'react'
import { ActionIcon, Button, SegmentedControl, Skeleton, Tooltip } from '@mantine/core'
import {
  IconChevronDown,
  IconCopy,
  IconCrop,
  IconDownload,
  IconFolder,
  IconHeart,
  IconHeartFilled,
  IconLayoutBoard,
  IconMessage,
  IconTrash,
} from '@tabler/icons-react'
import {
  STUDIO_UNSORTED,
  type StudioBackend,
  type StudioItem,
  type StudioSegments,
} from '@evaos/contract'
import { EvaMenu } from '../../overlay'
import { downloadAssets, favoriteAssets, mediaSrc, toast } from '../library/actions'
import { AddToCanvas, MoveMenu, SendToChat } from '../library/menus'
import {
  ANGLES,
  RELIGHT_DIRECTIONS,
  UPSCALE_FACTORS,
  VIDEO_SECONDS,
  angleRecipe,
  cutoutRecipe,
  regenerateRecipe,
  relightRecipe,
  upscaleRecipe,
  videoRecipe,
  type AngleId,
  type Recipe,
  type RelightDirection,
  type UpscaleFactor,
} from './recipes'

export interface EditorPanelProps {
  cur: StudioItem
  versions: readonly StudioItem[]
  backends: readonly StudioBackend[]
  /** The prompt bar's text: relight, angle and video use it when typed. */
  prompt: string
  /** SAM 2.1's objects for the current version; undefined until asked. */
  segments: StudioSegments | undefined
  /** Why the `segment` op was refused. */
  segmentError: string | undefined
  onRetrySegments: () => void
  selectedSegment: string | null
  onSelectSegment: (id: string | null) => void
  /** A child of this version is queued or running, or an op is on its way. */
  busy: boolean
  onRun: (recipe: Recipe) => void
  /** Combine: put '@' in the prompt bar and open the picker. */
  onCombine: () => void
  cropping: boolean
  onCropStart: () => void
  onCropDone: () => void
  onCropCancel: () => void
  onDelete: () => void
}

/** The editor's right panel: SAM 2.1 segments, the tools, and what to do with this version. */
export function EditorPanel(p: EditorPanelProps) {
  const { cur, backends, busy } = p
  const isVideo = cur.asset.kind === 'video'
  const off = busy || isVideo
  const [direction, setDirection] = useState<RelightDirection>('front')
  const [angle, setAngle] = useState<AngleId>('left45')
  const [factor, setFactor] = useState<UpscaleFactor>(2)
  const [seconds, setSeconds] = useState<number>(VIDEO_SECONDS[0])
  const [end, setEnd] = useState<string | null>(null)
  const [endMenu, setEndMenu] = useState(false)
  const mask = p.selectedSegment ?? undefined
  const endVersions = p.versions.filter(
    (v) => v.asset.id !== cur.asset.id && v.asset.kind === 'image',
  )
  const endFrame = endVersions.findIndex((v) => v.asset.id === end)
  const endId = endFrame >= 0 ? end! : undefined

  const recipes = {
    cutout: cutoutRecipe(cur, backends, { ...(mask !== undefined && { mask }) }),
    relight: relightRecipe(cur, backends, { direction, prompt: p.prompt }),
    angle: angleRecipe(cur, backends, { angle, prompt: p.prompt }),
    upscale: upscaleRecipe(cur, backends, { factor }),
    video: videoRecipe(cur, backends, {
      seconds,
      prompt: p.prompt,
      ...(endId !== undefined && { end: endId }),
    }),
    regenerate: regenerateRecipe(cur, backends),
  }
  const backend = backends.find((b) => b.id === cur.job.spec.backend)
  const madeWith =
    backend?.models?.find((m) => m.id === cur.job.spec.model)?.name ??
    backend?.label ??
    cur.job.spec.backend
  const favorite = cur.asset.favorite === true
  const label = (v: StudioItem): string => {
    const i = p.versions.indexOf(v)
    return i === 0 ? 'Original' : `Version ${i + 1}`
  }

  const apply = (key: keyof typeof recipes, text: string, disabled = off) => {
    const r = recipes[key]
    const button = (
      <Button
        size="compact-xs"
        variant="default"
        disabled={disabled || !r.ok}
        onClick={() => p.onRun(r)}
        data-testid={`studio-ed-${key}`}
      >
        {text}
      </Button>
    )
    return r.ok ? (
      button
    ) : (
      <Tooltip label={r.problem}>
        <span>{button}</span>
      </Tooltip>
    )
  }

  return (
    <aside className="ed-panel" data-testid="studio-ed-panel">
      <div className="ed-seghead">
        <b>Segments</b>
        <span className="ed-hint">SAM 2.1 (local)</span>
      </div>
      <div className="ed-segs" data-testid="studio-ed-segments">
        <SegmentRows {...p} />
      </div>

      <div className="ed-tl">
        <div className="ed-trow">
          <div className="ed-thead">
            <b>Remove background</b>
            {apply('cutout', 'Cut out')}
          </div>
          <div className="ed-hint">SAM 2.1 cutout</div>
        </div>
        <div className="ed-trow">
          <div className="ed-thead">
            <b>Relight</b>
            {apply('relight', 'Apply')}
          </div>
          <div className="ed-hint">Qwen relight LoRA</div>
          <div className="ed-dirs" role="radiogroup" aria-label="Light direction">
            {RELIGHT_DIRECTIONS.map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={direction === d}
                className={direction === d ? 'on' : ''}
                onClick={() => setDirection(d)}
                aria-label={`Light from ${d.replace('-', ' ')}`}
                title={d.replace('-', ' ')}
                data-testid={`studio-ed-dir-${d}`}
              />
            ))}
          </div>
        </div>
        <div className="ed-trow">
          <div className="ed-thead">
            <b>New angle</b>
            {apply('angle', 'Apply')}
          </div>
          <div className="ed-hint">Qwen multiple-angles LoRA</div>
          <SegmentedControl
            size="xs"
            fullWidth
            value={angle}
            onChange={(v) => setAngle(v as AngleId)}
            data={ANGLES.map((a) => ({ value: a.id, label: a.label }))}
            data-testid="studio-ed-angles"
          />
        </div>
        <div className="ed-trow">
          <div className="ed-thead">
            <b>Upscale</b>
            {apply('upscale', 'Apply')}
          </div>
          <div className="ed-hint">SeedVR2</div>
          <SegmentedControl
            size="xs"
            fullWidth
            value={String(factor)}
            onChange={(v) => setFactor(Number(v) as UpscaleFactor)}
            data={UPSCALE_FACTORS.map((f) => ({ value: String(f), label: `${f}x` }))}
            data-testid="studio-ed-factors"
          />
        </div>
        <div className="ed-trow">
          <div className="ed-thead">
            <b>Make video</b>
            {apply('video', 'Make')}
          </div>
          <div className="ed-hint">LTX-2.5, from this image</div>
          <SegmentedControl
            size="xs"
            fullWidth
            value={String(seconds)}
            onChange={(v) => setSeconds(Number(v))}
            data={VIDEO_SECONDS.map((s) => ({ value: String(s), label: `${s} s` }))}
            data-testid="studio-ed-seconds"
          />
          <EvaMenu opened={endMenu} onChange={setEndMenu} position="left-start" width={200}>
            <EvaMenu.Target>
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                justify="space-between"
                fullWidth
                disabled={isVideo || endVersions.length === 0}
                rightSection={<IconChevronDown size={12} />}
                data-testid="studio-ed-end"
              >
                End frame: {endId === undefined ? 'none' : label(endVersions[endFrame]!)}
              </Button>
            </EvaMenu.Target>
            <EvaMenu.Dropdown>
              <EvaMenu.Item onClick={() => setEnd(null)}>None</EvaMenu.Item>
              {endVersions.map((v) => (
                <EvaMenu.Item
                  key={v.asset.id}
                  onClick={() => setEnd(v.asset.id)}
                  leftSection={
                    <img
                      src={mediaSrc(v.asset.thumb)}
                      alt=""
                      style={{ width: 22, height: 22, borderRadius: 4, objectFit: 'cover' }}
                    />
                  }
                  data-testid="studio-ed-end-item"
                >
                  {label(v)}
                </EvaMenu.Item>
              ))}
            </EvaMenu.Dropdown>
          </EvaMenu>
        </div>
        <div className="ed-trow">
          <div className="ed-thead">
            <b>Combine</b>
            <Button
              size="compact-xs"
              variant="default"
              disabled={off}
              onClick={p.onCombine}
              data-testid="studio-ed-combine"
            >
              @ images
            </Button>
          </div>
          <div className="ed-hint">FLUX.2 klein. Type @ in the prompt bar to pick other images</div>
        </div>
        <div className="ed-trow">
          <div className="ed-thead">
            <b>Regenerate</b>
            {apply('regenerate', 'New seed', busy)}
          </div>
          <div className="ed-hint">Same prompt, new seed, {madeWith}</div>
        </div>
        <div className="ed-trow">
          <div className="ed-thead">
            <b>Crop</b>
            {p.cropping ? (
              <div>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  onClick={p.onCropCancel}
                  data-testid="studio-ed-crop-cancel"
                >
                  Cancel
                </Button>
                <Button
                  size="compact-xs"
                  variant="filled"
                  disabled={busy}
                  onClick={p.onCropDone}
                  data-testid="studio-ed-crop-done"
                >
                  Done
                </Button>
              </div>
            ) : (
              <ActionIcon
                variant="default"
                size="sm"
                disabled={off}
                onClick={p.onCropStart}
                aria-label="Crop"
                data-testid="studio-ed-crop-start"
              >
                <IconCrop size={14} />
              </ActionIcon>
            )}
          </div>
          <div className="ed-hint">Local, no AI</div>
        </div>
      </div>

      <div className="ed-actions">
        <div className="ed-send">
          <SendToChat
            ids={[cur.asset.id]}
            trigger={
              <Button
                size="compact-sm"
                variant="default"
                leftSection={<IconMessage size={15} />}
                data-testid="studio-ed-send-chat"
              >
                Send to chat
              </Button>
            }
          />
          <AddToCanvas
            ids={[cur.asset.id]}
            trigger={
              <Button
                size="compact-sm"
                variant="default"
                leftSection={<IconLayoutBoard size={15} />}
                data-testid="studio-ed-add-canvas"
              >
                Add to canvas
              </Button>
            }
          />
        </div>
        <div className="ed-icons">
          <Tooltip label={favorite ? 'Unfavorite' : 'Favorite'}>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label={favorite ? 'Unfavorite' : 'Favorite'}
              aria-pressed={favorite}
              onClick={() => void favoriteAssets([cur.asset.id], !favorite)}
              data-testid="studio-ed-favorite"
            >
              {favorite ? <IconHeartFilled size={18} /> : <IconHeart size={18} />}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Download">
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Download"
              onClick={() => void downloadAssets([cur.asset.id])}
              data-testid="studio-ed-download"
            >
              <IconDownload size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Copy prompt">
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Copy prompt"
              onClick={() =>
                void navigator.clipboard
                  .writeText(cur.job.spec.prompt)
                  .then(() => toast('Prompt copied'))
                  .catch(() => toast('Could not copy the prompt'))
              }
              data-testid="studio-ed-copy"
            >
              <IconCopy size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Delete">
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Delete"
              onClick={p.onDelete}
              data-testid="studio-ed-delete"
            >
              <IconTrash size={18} />
            </ActionIcon>
          </Tooltip>
          <MoveMenu
            ids={[cur.asset.id]}
            current={cur.job.project ?? STUDIO_UNSORTED}
            trigger={
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label="Move to project"
                data-testid="studio-ed-move"
              >
                <IconFolder size={18} />
              </ActionIcon>
            }
          />
        </div>
      </div>
    </aside>
  )
}

/** Segment rows: skeletons while SAM 2.1 works, then each object with its cut-out. */
function SegmentRows(p: EditorPanelProps) {
  if (p.cur.asset.kind === 'video') {
    return <div className="ed-hint ed-segnote">Segments work on images</div>
  }
  const s = p.segments
  if (p.segmentError !== undefined || s?.state === 'failed') {
    return (
      <div className="ed-hint ed-segnote" data-testid="studio-ed-seg-error">
        {p.segmentError ?? s?.error ?? 'SAM 2.1 could not run'}{' '}
        <Button size="compact-xs" variant="subtle" onClick={p.onRetrySegments}>
          Try again
        </Button>
      </div>
    )
  }
  if (!s || s.state !== 'done' || p.busy) {
    return Array.from({ length: 5 }, (_, i) => (
      <div className="ed-seg" key={i} data-testid="studio-ed-seg-skeleton">
        <Skeleton h={34} w={34} radius="sm" />
        <Skeleton h={10} w={70 + (i % 3) * 20} />
      </div>
    ))
  }
  if (s.segments.length === 0) {
    return <div className="ed-hint ed-segnote">No objects found</div>
  }
  return s.segments.map((seg) => (
    <button
      key={seg.id}
      type="button"
      className={`ed-seg${p.selectedSegment === seg.id ? ' on' : ''}`}
      aria-pressed={p.selectedSegment === seg.id}
      onClick={() => p.onSelectSegment(p.selectedSegment === seg.id ? null : seg.id)}
      data-testid="studio-ed-seg"
      data-id={seg.id}
    >
      <img src={mediaSrc(seg.thumb)} alt="" />
      <span>{seg.label}</span>
    </button>
  ))
}
