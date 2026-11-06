// The Skills editor's comments and suggestions drawn into the document: a comment's text is
// highlighted (the open thread's more strongly), an agent's suggested change shows inline as a diff
// (the text it replaced struck through in red before its typed text in green, inserted blocks tinted
// green). Everything lives in the shared Y.Doc (@relay/canvas-live/doc-threads), so the drawing is
// rebuilt from the threads and suggestions maps on every change; nothing is a ProseMirror mark, so
// SKILL.md never sees any of it.
import { Extension, type Editor } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from '@tiptap/y-tiptap'
import * as Y from 'yjs'
import {
  docThreadsOf,
  runsText,
  snapDocThreads,
  snapSuggestions,
  suggestionsOf,
  type RelPos,
  type TextAnchor,
} from '@relay/canvas-live/doc-threads'

export interface DocCommentsOptions {
  doc: Y.Doc | null
  /** The thread whose highlight is drawn as open. */
  active: () => string | null
  /** Text a comment is being written about, highlighted like an open thread. */
  pending: () => TextAnchor | null
  /** A click in the text: the thread under it, or null. */
  onClick: (thread: string | null) => void
}

const key = new PluginKey<DecorationSet>('docComments')
/** Meta that makes the plugin redraw (the Y maps or the open thread changed). */
const REDRAW = 'docComments.redraw'

/** Where `rel` is in the editor now; null before the sync binding is up or when its text is gone. */
export function pmPos(state: EditorState, rel: RelPos): number | null {
  const sync = ySyncPluginKey.getState(state)
  if (!sync?.binding) return null
  try {
    return relativePositionToAbsolutePosition(
      sync.doc,
      sync.type,
      Y.createRelativePositionFromJSON(rel),
      sync.binding.mapping,
    )
  } catch {
    return null
  }
}

/** A range's positions in the editor, `from` before `to`; null when either is gone. */
export function pmRange(
  state: EditorState,
  from: RelPos,
  to: RelPos,
): { from: number; to: number } | null {
  const a = pmPos(state, from)
  const b = pmPos(state, to)
  return a === null || b === null ? null : { from: Math.min(a, b), to: Math.max(a, b) }
}

/**
 * The anchor for the editor's text from `from` to `to`: its ends stick to its first and last
 * characters, so typing right before or after the commented text does not grow it. Null before
 * the sync binding is up.
 */
export function anchorOf(state: EditorState, from: number, to: number): TextAnchor | null {
  const sync = ySyncPluginKey.getState(state)
  if (!sync?.binding || to <= from) return null
  const { doc, type, binding } = sync
  // y-tiptap ties a position to the character before it (assoc -1): what the end wants.
  const rel = (pos: number): Y.RelativePosition =>
    absolutePositionToRelativePosition(pos, type, binding.mapping)
  const end = rel(to)
  // The start is tied to its first character (assoc 0) when that resolves to the same place.
  const before = rel(from)
  const first = rel(from + 1)
  const tied = first.item ? new Y.RelativePosition(first.type, first.tname, first.item, 0) : null
  const at = Y.createAbsolutePositionFromRelativePosition(before, doc)
  const tiedAt = tied && Y.createAbsolutePositionFromRelativePosition(tied, doc)
  const start =
    tied && at && tiedAt && tiedAt.type === at.type && tiedAt.index === at.index ? tied : before
  return {
    from: Y.relativePositionToJSON(start) as RelPos,
    to: Y.relativePositionToJSON(end) as RelPos,
    quote: state.doc.textBetween(from, to, '\n'),
  }
}

/** A struck-through copy of the text a suggestion replaced, drawn where it was. */
function removedWidget(text: string): HTMLElement {
  const del = document.createElement('del')
  del.className = 'eva-doc-del'
  del.textContent = text
  return del
}

function draw(
  state: EditorState,
  doc: Y.Doc,
  active: string | null,
  pending: TextAnchor | null,
): DecorationSet {
  const out: Decoration[] = []
  const draft = pending && pmRange(state, pending.from, pending.to)
  if (draft && draft.to > draft.from)
    out.push(
      Decoration.inline(draft.from, draft.to, { class: 'eva-doc-comment', 'data-active': 'true' }),
    )
  const suggested = new Set(snapSuggestions(doc).map((s) => s.thread))
  for (const thread of snapDocThreads(docThreadsOf(doc))) {
    // A resolved thread's highlight goes, unless it is the one open.
    if ((thread.resolved && thread.id !== active) || thread.anchor === null) continue
    const range = pmRange(state, thread.anchor.from, thread.anchor.to)
    if (range === null || range.to <= range.from) continue
    out.push(
      Decoration.inline(range.from, range.to, {
        class: 'eva-doc-comment',
        'data-thread': thread.id,
        ...(thread.id === active ? { 'data-active': 'true' } : {}),
        // Its change's diff colours the text instead.
        ...(suggested.has(thread.id) ? { 'data-suggested': 'true' } : {}),
      }),
    )
  }
  for (const s of snapSuggestions(doc)) {
    s.hunks.forEach((hunk, i) => {
      const range = pmRange(state, hunk.from, hunk.to)
      if (range === null) return
      if (hunk.kind === 'blocks') {
        // Each inserted block (a top-level block, or list items added to a list) is tinted whole.
        state.doc.nodesBetween(range.from, range.to, (node, pos) => {
          if (pos < range.from || pos + node.nodeSize > range.to) return true
          if (node.isBlock)
            out.push(
              Decoration.node(pos, pos + node.nodeSize, {
                class: 'eva-doc-ins-block',
                'data-suggestion': s.id,
              }),
            )
          return false
        })
        return
      }
      const removed = runsText(hunk.removed)
      if (removed !== '')
        out.push(
          Decoration.widget(range.from, () => removedWidget(removed), {
            side: -1,
            key: `del:${s.id}:${i}:${removed}`,
            ignoreSelection: true,
          }),
        )
      if (range.to > range.from)
        out.push(
          Decoration.inline(range.from, range.to, {
            class: 'eva-doc-ins',
            'data-suggestion': s.id,
          }),
        )
    })
  }
  return DecorationSet.create(state.doc, out)
}

/** Redraws the comments and suggestions (after a change to the Y maps or the open thread). */
export function redrawComments(editor: Editor): void {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta(REDRAW, true))
}

export const DocComments = Extension.create<DocCommentsOptions>({
  name: 'docComments',

  addOptions() {
    return { doc: null, active: () => null, pending: () => null, onClick: () => undefined }
  },

  addProseMirrorPlugins() {
    const { doc, active, pending, onClick } = this.options
    if (doc === null) return []
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_config, state) => draw(state, doc, active(), pending()),
          // Remote edits arrive as ProseMirror transactions too, so any doc change redraws.
          apply: (tr, old, _before, state) =>
            tr.docChanged || tr.getMeta(REDRAW) === true || tr.getMeta(ySyncPluginKey) !== undefined
              ? draw(state, doc, active(), pending())
              : old,
        },
        props: {
          decorations: (state) => key.getState(state),
          handleClick: (_view: EditorView, _pos: number, event: MouseEvent) => {
            const target = event.target instanceof Element ? event.target : null
            const hit = target?.closest('[data-thread]')?.getAttribute('data-thread') ?? null
            onClick(hit)
            return false
          },
        },
        view: (view) => {
          // Deferred: a Y change can land while the sync plugin is still applying one to the view.
          const redraw = (): void =>
            queueMicrotask(() => {
              if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(REDRAW, true))
            })
          const threads = docThreadsOf(doc)
          const suggestions = suggestionsOf(doc)
          threads.observeDeep(redraw)
          suggestions.observe(redraw)
          return {
            destroy: () => {
              threads.unobserveDeep(redraw)
              suggestions.unobserve(redraw)
            },
          }
        },
      }),
    ]
  },
})
