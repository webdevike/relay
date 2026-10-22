// The chat gallery session (fixtures/agent-gallery), bundled into the renderer so the Test Bench can
// show it through the real chat components in any build: no omp process, no IPC, no writes.
import galleryText from '../../../../../fixtures/agent-gallery/sessions/-fixture/2026-10-20T09-00-00-000Z_chat-gallery.jsonl?raw'
import mtimesText from '../../../../../fixtures/agent-gallery/mtimes.json?raw'
import { backgroundJobs, subagentsFromListing } from '@evaos/chat-core/jobs'
import type {
  BgJob,
  ChatImage,
  ChatMessage,
  Dialog,
  SessionMeta,
  Subagent,
} from '@evaos/chat-core/message'
import { imageFrom, oneLine, parseSession } from '@evaos/chat-core/session'

const subagentFiles = import.meta.glob<string>(
  '../../../../../fixtures/agent-gallery/sessions/-fixture/2026-10-20T09-00-00-000Z_chat-gallery/*',
  { query: '?raw', import: 'default', eager: true },
)
const blobFiles = import.meta.glob<string>('../../../../../fixtures/agent-gallery/blobs/*.png', {
  query: '?inline',
  import: 'default',
  eager: true,
})

export const GALLERY_FILE = 'test-bench:chat-gallery.jsonl'
const BLOB = /^blob:sha256:([a-f0-9]{64})$/
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/** Blob store images are bundled too, so they decode like inline ones instead of asking main. */
function bundledImage(image: ChatImage): ChatImage {
  const hash = BLOB.exec(image.src ?? '')?.[1]
  if (hash === undefined) return image
  const entry = Object.entries(blobFiles).find(([p]) => baseName(p) === `${hash}.png`)
  if (!entry) return image
  const data = entry[1].slice(entry[1].indexOf(',') + 1)
  return { ...imageFrom({ type: 'image', data }, 0), label: image.label }
}

export interface Gallery {
  title: string
  messages: ChatMessage[]
  meta: SessionMeta
  subagents: Subagent[]
  jobs: BgJob[]
}

/** Parses the bundled session the way the transcript path does. `now` dates the file mtimes. */
export function loadGallery(now = Date.now()): Gallery {
  const parsed = parseSession(galleryText)
  const messages = parsed.messages.map((m) =>
    m.images.length === 0 ? m : { ...m, images: m.images.map(bundledImage) },
  )
  const minutesAgo = JSON.parse(mtimesText) as Record<string, number>
  const listing = Object.keys(subagentFiles).map((p) => {
    const name = baseName(p)
    const stem = name.replace(/\.(jsonl|md)$/, '')
    return { name, mtimeMs: now - (minutesAgo[`chat-gallery/${stem}`] ?? 0) * 60_000 }
  })
  const subagents = subagentsFromListing(listing).map((s) => {
    const text = Object.entries(subagentFiles).find(([p]) => baseName(p) === s.file)?.[1] ?? ''
    const last = parseSession(text)
      .messages.filter((m) => m.role === 'assistant')
      .at(-1)
    return { ...s, failed: false, lastLine: last ? oneLine(last.text, 160) : '' }
  })
  return {
    title: parsed.title,
    messages,
    meta: parsed.meta,
    subagents,
    jobs: backgroundJobs(galleryText),
  }
}

/** One example of every card the composer slot can show, with gallery content. */
export const GALLERY_DIALOGS = {
  ask: {
    kind: 'ask',
    id: 'gallery-ask',
    questions: [
      {
        id: 'q1',
        question: 'Apply the same fix to the eCard export now?',
        options: [
          { label: 'Yes, fix eCard now', description: 'One line in reports/csv.ts plus a test' },
          { label: 'Open a Linear ticket instead' },
          { label: 'Wait until the Relay fix ships' },
          { label: 'Skip eCard' },
        ],
        recommended: 0,
        multi: false,
      },
    ],
  },
  askMulti: {
    kind: 'ask',
    id: 'gallery-ask-multi',
    questions: [
      {
        id: 'where',
        header: 'Rollout',
        question: 'Where should the fix land first?',
        options: [{ label: 'Relay' }, { label: 'eCard' }],
        recommended: 0,
        multi: false,
      },
      {
        id: 'checks',
        question: 'Which checks should run before the push?',
        options: [
          { label: 'Export unit tests' },
          { label: 'October fixture replay' },
          { label: 'Full e2e suite', description: 'About 12 minutes' },
        ],
        multi: true,
      },
    ],
  },
  select: {
    kind: 'select',
    id: 'gallery-select',
    title: 'Which month should the regression fixture use?',
    options: [
      { label: 'October 2026', description: '214 invoices, ends on a partial page' },
      { label: 'September 2026' },
      { label: 'August 2026' },
      { label: 'A synthetic 51 row month' },
      { label: 'All of them' },
    ],
  },
  confirm: {
    kind: 'confirm',
    id: 'gallery-confirm',
    title: 'Push the export fix to main?',
    message: 'This runs the Relay deploy hook and regenerates the October CSV for finance.',
  },
  input: {
    kind: 'input',
    id: 'gallery-input',
    title: 'Linear ticket title',
    placeholder: 'Relay export drops the last row',
  },
  editor: {
    kind: 'editor',
    id: 'gallery-editor',
    title: 'Commit message',
    prefill:
      'fix(export): write the last pending row\n\nThe look-behind loop in writeCsv never wrote the final row.',
  },
} satisfies Record<string, Dialog>

export type GalleryDialogKey = keyof typeof GALLERY_DIALOGS
