// Shared Studio actions for the landing and the editor. Every change is an op the host keeps
// (favorites, moves, trash, projects, references); toasts say what happened, with Undo where a
// change can be taken back.
import { useMemo } from 'react'
import {
  STUDIO_UNSORTED,
  studioFamily,
  studioItems,
  studioLineage,
  type StudioAnswer,
  type StudioBackend,
  type StudioItem,
  type StudioJob,
  type StudioLineage,
  type StudioParent,
  type StudioProject,
  type StudioReference,
  type StudioReferenceKind,
  type StudioSpec,
} from '@evaos/contract'
import { mediaUrl } from '../../chat/widgets/media-url'
import { invoke } from '../../ipc'
import { downloadName } from '../studio-assets'
import { applyStudioChange, studioRequest, studioStore, useStudio } from '../studio-store'
import { localStore, openModal, openView, setSelected, type Toast } from './local'

const TOAST_MS = 6000
const MAX_TOASTS = 3

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

let toastSeq = 0

/** A short line at the bottom of Studio, optionally with one action (Undo). */
export function toast(text: string, action?: Toast['action'], ms = TOAST_MS): void {
  const id = ++toastSeq
  localStore.setState((s) => ({
    toasts: [...s.toasts.slice(-(MAX_TOASTS - 1)), { id, text, action }],
  }))
  setTimeout(() => dismissToast(id), ms)
}

export function dismissToast(id: number): void {
  localStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

/** A host path (`/studio/<id>/<token>`, `/thumb`) as a URL the page can load. */
export function mediaSrc(path: string): string {
  return mediaUrl(path)
}

/** The library as the host last sent it: live images newest first, their lineage, projects, references. */
export function useLibrary(): {
  items: StudioItem[]
  lineage: StudioLineage
  projects: StudioProject[]
  references: StudioReference[]
  backends: StudioBackend[]
  jobs: StudioJob[]
} {
  const jobs = useStudio((s) => s.view.jobs)
  const projects = useStudio((s) => s.view.projects)
  const references = useStudio((s) => s.view.references)
  const backends = useStudio((s) => s.view.backends)
  const { items, lineage } = useMemo(() => {
    const list = studioItems(jobs)
    return { items: list, lineage: studioLineage(list) }
  }, [jobs])
  return { items, lineage, projects, references, backends, jobs }
}

/** Every live image by asset id, from the store now. */
function itemsNow(): Map<string, StudioItem> {
  return new Map(studioItems(studioStore.getState().view.jobs).map((i) => [i.asset.id, i]))
}

export function projectName(id: string, projects: readonly StudioProject[]): string {
  if (id === STUDIO_UNSORTED) return 'Unsorted'
  return projects.find((p) => p.id === id)?.name ?? 'Unsorted'
}

function dropFromSelection(ids: readonly string[]): void {
  const { selected } = localStore.getState()
  setSelected(selected.filter((x) => !ids.includes(x)))
}

/** Sends one op; a refusal is shown as a toast and resolves false. */
async function send(
  op: Parameters<typeof studioRequest>[0],
  failure: string,
): Promise<StudioAnswer> {
  const a = await studioRequest(op)
  if (!a.ok) toast(a.error ? `${failure}: ${a.error}` : failure, undefined, 8000)
  return a
}

/**
 * Deletes images with everything made from them (an original takes every version, a version its own
 * edits), after one confirm that says how many images go. Hidden at once, restorable for ten minutes
 * (Undo), then the host deletes every copy. `after` runs once Isaac confirms.
 */
export function trashAssets(ids: string[], after?: () => void): void {
  if (ids.length === 0) return
  const lineage = studioLineage(studioItems(studioStore.getState().view.jobs))
  const family = studioFamily(ids, lineage)
  const extra = family.length - ids.length
  openModal({
    kind: 'confirm',
    title: `Delete ${plural(family.length, 'image')}?`,
    body:
      extra > 0
        ? `That is ${plural(ids.length, 'image')} and the ${plural(extra, 'edit')} made from ${ids.length === 1 ? 'it' : 'them'}. You can undo for ten minutes; then the files are deleted.`
        : 'You can undo for ten minutes; then the files are deleted.',
    cta: 'Delete',
    danger: true,
    onConfirm: () => {
      after?.()
      void trashNow(family)
    },
  })
}

async function trashNow(ids: string[]): Promise<void> {
  dropFromSelection(ids)
  const a = await send({ kind: 'trash', assets: ids }, "Couldn't delete")
  if (!a.ok) return
  toast(`Deleted ${plural(ids.length, 'image')}`, {
    label: 'Undo',
    run: () => void send({ kind: 'restore', assets: ids }, "Couldn't restore"),
  })
}

/** Move images to a project (STUDIO_UNSORTED for none), with Undo back to where each was. */
export async function moveAssets(ids: string[], project: string): Promise<void> {
  if (ids.length === 0) return
  const now = itemsNow()
  const before = new Map<string, string[]>()
  for (const id of ids) {
    const job = now.get(id)?.job
    const from = job?.project ?? STUDIO_UNSORTED
    if (from === project) continue
    before.set(from, [...(before.get(from) ?? []), id])
  }
  const a = await send({ kind: 'move', assets: ids, project }, "Couldn't move")
  if (!a.ok) return
  const { projects } = studioStore.getState().view
  toast(`Moved ${plural(ids.length, 'image')} to ${projectName(project, projects)}`, {
    label: 'Undo',
    run: () => {
      for (const [from, back] of before)
        void send({ kind: 'move', assets: back, project: from }, "Couldn't undo")
    },
  })
}

/** Favorite (or unfavorite) images. */
export async function favoriteAssets(ids: string[], value: boolean): Promise<void> {
  if (ids.length === 0) return
  const a = await send({ kind: 'favorite', assets: ids, value }, "Couldn't change favorites")
  if (!a.ok) return
  toast(
    value
      ? `Added ${plural(ids.length, 'image')} to favorites`
      : `Removed ${plural(ids.length, 'image')} from favorites`,
    undefined,
    2500,
  )
}

/** Favorites them all, or clears them when every one already is. */
export function toggleFavorites(ids: string[]): Promise<void> {
  const now = itemsNow()
  const all = ids.every((id) => now.get(id)?.asset.favorite === true)
  return favoriteAssets(ids, !all)
}

/** Saves every file into Downloads; Finder shows the folder once. */
export async function downloadAssets(ids: string[]): Promise<void> {
  const now = itemsNow()
  const assets = ids.flatMap((id) => {
    const asset = now.get(id)?.asset
    return asset ? [asset] : []
  })
  if (assets.length === 0) return
  const results = await Promise.all(
    assets.map((a) => invoke('studio.download', { path: a.path, name: downloadName(a) })),
  )
  const failed = results.filter((r) => !r.ok).length
  if (failed === 0) toast(`Saved ${plural(assets.length, 'file')} to Downloads`, undefined, 3000)
  else toast(`Saved ${assets.length - failed} of ${assets.length} to Downloads`, undefined, 8000)
}

/** Queues `count` jobs (one each); the host's refusal is a toast. The jobs show before their push. */
export async function createJobs(op: {
  spec: StudioSpec
  count?: number
  project?: string
  parent?: StudioParent
}): Promise<StudioAnswer> {
  const a = await studioRequest({
    kind: 'create',
    spec: op.spec,
    ...(op.count !== undefined && op.count > 1 ? { count: op.count } : {}),
    ...(op.project === undefined ? {} : { project: op.project }),
    ...(op.parent === undefined ? {} : { parent: op.parent }),
  })
  if (!a.ok) {
    toast(a.error ?? "Relay didn't queue the job", undefined, 8000)
    return a
  }
  for (const job of a.jobs ?? (a.job ? [a.job] : [])) applyStudioChange({ kind: 'job', job })
  return a
}

/** Asks for a project name, creates it, then runs `then` with its id. */
export function newProjectModal(then?: (id: string) => void): void {
  openModal({
    kind: 'name',
    title: 'New project',
    initial: '',
    cta: 'Create',
    placeholder: 'Project name',
    onSubmit: (name) =>
      void send({ kind: 'project.create', name }, "Couldn't create the project").then((a) => {
        if (a.ok && a.project) then?.(a.project.id)
      }),
  })
}

export function renameProjectModal(id: string): void {
  const p = studioStore.getState().view.projects.find((x) => x.id === id)
  if (!p) return
  openModal({
    kind: 'name',
    title: 'Rename project',
    initial: p.name,
    cta: 'Save',
    placeholder: 'Project name',
    onSubmit: (name) => void send({ kind: 'project.rename', id, name }, "Couldn't rename it"),
  })
}

/** Deletes a project (its images go to Unsorted), with Undo that brings it and its images back. */
export function deleteProjectModal(id: string): void {
  const { view } = studioStore.getState()
  const p = view.projects.find((x) => x.id === id)
  if (!p) return
  const ids = [...itemsNow().values()].filter((i) => i.job.project === id).map((i) => i.asset.id)
  openModal({
    kind: 'confirm',
    title: `Delete "${p.name}"?`,
    body: ids.length
      ? `Its ${plural(ids.length, 'image')} move to Unsorted. Nothing is lost.`
      : 'It is empty.',
    cta: 'Delete project',
    danger: true,
    onConfirm: () =>
      void send({ kind: 'project.delete', id }, "Couldn't delete the project").then((a) => {
        if (!a.ok) return
        if (localStore.getState().view === id) openView('all')
        toast(`Deleted project "${p.name}"`, {
          label: 'Undo',
          run: () =>
            void send({ kind: 'project.create', name: p.name, id }, "Couldn't undo").then((b) => {
              if (b.ok && ids.length)
                void send({ kind: 'move', assets: ids, project: id }, "Couldn't undo")
            }),
        })
      }),
  })
}

/** Saves an image as a Style or Character (the host keeps its own copy). */
export function saveReferenceModal(asset: string | null, kind: StudioReferenceKind): void {
  if (asset === null) {
    toast('Open or select an image first, then save it as a reference', undefined, 3500)
    return
  }
  const label = kind === 'style' ? 'style' : 'character'
  openModal({
    kind: 'name',
    title: `Save as ${label}`,
    initial: '',
    cta: 'Save',
    placeholder: kind === 'style' ? 'Style name' : 'Character name',
    onSubmit: (name) =>
      void send(
        { kind: 'reference.create', asset, referenceKind: kind, name },
        "Couldn't save the reference",
      ).then((a) => {
        if (a.ok) toast(`Saved ${name.trim()}`, undefined, 2500)
      }),
  })
}

export async function deleteReference(ref: StudioReference): Promise<void> {
  const a = await send({ kind: 'reference.delete', id: ref.id }, "Couldn't delete the reference")
  if (a.ok) toast(`Deleted ${ref.name}`, undefined, 2500)
}

export async function cancelJob(id: string): Promise<void> {
  await send({ kind: 'cancel', id }, "Couldn't cancel it")
}
