import { useEffect, useRef } from 'react'
import type { Place } from '@evaos/shell-core'
import type { StudioDraft } from '@evaos/contract'
import { DISMISS_PRIORITY, useDismissable } from '../hotkeys/dismiss'
import { StudioEditor } from './editor/StudioEditor'
import { toggleFavorites, trashAssets, useLibrary } from './library/actions'
import { createChoices, choiceKey } from './library/create-models'
import { Dock, ModalHost, Toasts } from './library/Dock'
import { Feed, Filters, Header, useGrid } from './library/Feed'
import { clearSelection, localStore, setComposer, setSelected, useLocal } from './library/local'
import { Rail } from './library/Rail'
import { startStudio, studioStore, useStudio } from './studio-store'
import './studio.css'

const typing = (t: EventTarget | null): boolean =>
  t instanceof HTMLInputElement ||
  t instanceof HTMLTextAreaElement ||
  (t instanceof HTMLElement && t.isContentEditable)

/** An agent's draft in the create bar: what the bar can take (prompt, model, aspect, refs). */
function fillFromDraft(draft: StudioDraft): void {
  const { backends } = studioStore.getState().view
  const key =
    draft.backend === undefined ? undefined : choiceKey(draft.backend, draft.model ?? undefined)
  const choice = createChoices(backends).find((c) => c.key === key || c.backend === draft.backend)
  const { composer } = localStore.getState()
  setComposer({
    prompt: draft.prompt ?? composer.prompt,
    ...(choice ? { choice: choice.key } : {}),
    ...(draft.aspect ? { aspect: draft.aspect } : {}),
    ...(draft.refs ? { refs: draft.refs } : {}),
    ...(draft.seed === undefined ? {} : { seedMode: 'fixed' as const, seed: draft.seed }),
    focus: composer.focus + 1,
  })
}

/**
 * Studio: the host's image library. A projects rail, the open view's grid of originals with
 * filters and multi-select, and a create bar (or the bulk bar while images are selected). A tile
 * opens the editor over the page. Everything Isaac changes is an op the host keeps.
 */
export function StudioPage(_props: { place: Place }) {
  useEffect(() => startStudio(), [])
  const view = useStudio((s) => s.view)
  const loadError = useStudio((s) => s.error)
  const request = useStudio((s) => s.request)
  const editing = useLocal((s) => s.editing)
  const selecting = useLocal((s) => s.selected.length > 0 || s.selectMode)
  const { lineage } = useLibrary()
  const grid = useGrid()
  const order = useRef(grid.order)
  order.current = grid.order
  /** A studio.open for a job without an output yet: it opens when the output lands. */
  const waitingJob = useRef<string | null>(null)

  const open = (id: string): void => localStore.setState({ editing: id })

  useEffect(() => {
    if (!request || !view.loaded) return
    studioStore.setState({ request: null })
    if ('job' in request) waitingJob.current = request.job
    else fillFromDraft(request.draft)
  }, [request, view.loaded])

  useEffect(() => {
    const id = waitingJob.current
    if (id === null) return
    const asset = view.jobs.find((j) => j.id === id)?.outputs.find((o) => o.deletedAt === undefined)
    if (!asset) return
    waitingJob.current = null
    localStore.setState({ editing: asset.id, selected: [], selectMode: false })
  }, [view.jobs, request])

  // The editor closes itself when its image goes away (trashed elsewhere).
  useEffect(() => {
    if (editing !== null && view.loaded && !lineage.byId.has(editing)) {
      localStore.setState({ editing: null })
    }
  }, [editing, lineage, view.loaded])

  useDismissable(DISMISS_PRIORITY.selection, clearSelection, selecting && editing === null)

  useEffect(() => {
    if (editing !== null) return
    const onKey = (e: KeyboardEvent): void => {
      const s = localStore.getState()
      if (s.modal || typing(e.target)) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSelected([...order.current])
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selected.length > 0) {
        e.preventDefault()
        trashAssets(s.selected)
      } else if (
        (e.key === 'f' || e.key === 'F') &&
        s.selected.length > 0 &&
        !e.metaKey &&
        !e.ctrlKey
      ) {
        void toggleFavorites(s.selected)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing])

  const notice = !view.up
    ? "Relay isn't connected. Studio comes back when it is."
    : view.loaded && view.backends.length === 0
      ? "This Relay host doesn't have Studio."
      : loadError

  return (
    <div className="sl-page" data-testid="page-studio">
      <Rail />
      <div className="sl-main">
        <Header total={grid.items.length} />
        <Filters />
        <Feed grid={grid} onOpen={open} />
        {editing === null ? <Dock order={grid.order} notice={notice} /> : null}
      </div>
      {editing !== null ? (
        <>
          <StudioEditor assetId={editing} onClose={() => localStore.setState({ editing: null })} />
          <div className="sl-toast-layer">
            <Toasts />
          </div>
        </>
      ) : null}
      <ModalHost />
    </div>
  )
}
