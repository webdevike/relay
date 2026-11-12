# Design Mode

Point at elements of a page in a Relay page tab, say what should change, and send it to the
workspace's chat; the agent edits the code, the page hot-reloads and the selection stays. Built for
local dev pages (`localhost:5173`, a port such as `3000` in the address field); it works on any page.
Inspired by TasteCode's browser annotations (Apache-2.0, see `THIRD_PARTY_NOTICES.md`).

## Try it

1. Open a chat, open a page tab beside it (+ in a tool pane, then Browser) and load your dev server.
2. Press the pointer button at the right of the address row (`btn-design-mode`). The inspector
   opens beside the page (under it when the pane is narrower than 720 px). A pane narrower than
   420 px hides the button while the mode is off, so the address keeps its room.
3. Hover: the element under the pointer gets an outline and its tag. Clicks, hovers and keys
   (typing, paste, the page's own shortcuts) stay out of the page while the mode is on; Relay's
   shortcuts still work and the wheel still scrolls the page.
4. Click to select; Shift-click adds or removes one (up to 8). Each selected element keeps a
   numbered outline. Drag over an area to select it as a region (Shift-drag adds it): its
   screenshot only, listed after the elements as `Region WxH`.
5. In the inspector: the element (`button#save`), its component and source `file:line`, its
   screenshot and computed styles. Edit a style value (Enter or leaving the field previews it in
   the page; the undo arrow puts it back; a value CSS does not take is refused with the reason).
   "Draw on it" opens the screenshot to mark it with a pen. A region shows its screenshot and
   "Draw on it" only.
6. Say what should change, either way:
   - In the panel: describe it ("8px tighter") in the comment field and press Submit (Cmd+Enter
     in the field). It goes to the chat that owns the page (the chat of its workspace, or the chat
     whose agent drives it) as your own message, a page note of intent `change`
     (`docs/agent-presence.md`): every element's selector, DOM, source, component, computed
     styles, your style edits and its screenshot (a drawn one in place of the plain crop), saved
     under `<configDir>/notes/` and attached as images. A page of a new chat not started yet has
     no owner: Submit says so.
   - In the chat: while elements are selected, the owning chat's composer shows a chip per
     element or region (name and a screenshot thumbnail, the one you drew on when you did) and one
     chip for style edits ("3 style edits"). Type the request in the chat as usual; sending the
     message sends the same note text and screenshots with it (`design.compose`), and the chips
     are spent. Removing a chip drops that selection (the edits chip puts the page's values
     back).

   Either way it is one message in the one owning chat, shown as a slim inline line like a system
   line, not a card: the pointer icon, "You commented on `div.card:nth-of-type(5)` · the tab's
   title", what you said, a tiny screenshot and Show, which opens the whole note (page address,
   DOM, source, styles). There is never a separate thread. Page notes and canvas comments render
   the same way (`packages/chat-core/src/background.ts`, `BackgroundRow.tsx`).

7. The page reloads or hot-updates: the selection is found again (see Selectors) and the
   inspector refreshes.
8. Drag the panel by its header to dock it to another edge of the page tab (left, right, top,
   bottom): the page view parks while you drag and the four docks show; it lands on the one the
   pointer leans to. The dock is remembered per tab while Relay runs. A native page paints over
   anything the shell draws, so the panel docks beside the page rather than floating over it.
9. Esc (in the page or in Relay) or the toggle ends the mode. Leaving the site or closing the tab
   ends it too.

## Source locations

In this order, walking up from the element:

| Where                                                                                                            | How exact                                                  |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| React's `_debugSource` (React 18 and older dev builds with the JSX source transform)                             | Exact file, line and column                                |
| React 19's `_debugStack`, first frame outside `node_modules` and React                                           | Approximate: the dev server's file path and generated line |
| `data-source` / `data-source-loc`, `data-inspector-relative-path` + `-line`/`-column`, `data-sentry-source-file` | As the build plugin wrote it                               |

The component name comes from the fiber's owner, else `data-component`, `data-sentry-component` or
`data-component-name`.

## How it works

- Contract: `packages/contract/src/design.ts` (`design.set`, `design.select`, `design.style`,
  `design.send`; events `design.selection`, `design.exit`); the note's fields and text in
  `agent-presence.ts` (`BrowserNoteTarget`, `noteText`).
- Main, `src/main/browser/design-mode.ts`: one session per page tab. Isaac's pointer goes through
  the page note picker (`annotate-picker.ts`) in mode `design`: a loop of picks, each answering a
  click (with Shift) or a dragged region; the picker outlines what is hovered and reaches into
  open shadow roots. While the mode is on, main turns on the pointer gate of the guest preload
  (`src/preload/design-gate.ts`, `DESIGN_GATE_CHANNEL`, again on every `dom-ready`); a new
  document's top frame also asks main as it starts (`DESIGN_GATE_QUERY`), so a reload or
  navigation is gated as soon as main answers, well before `dom-ready` (a gate message that came
  first wins over the answer). The gate's window capture listeners, registered before any page
  script, stop every mouse and pointer event, enter and leave included (not the wheel), cancel
  presses, clicks and context menus (no focus, link or checkbox reacts), and hand moves, presses
  and releases to the picker as `relay-design-input` events, so no listener of the page's sees the
  pointer, between picks as well. Frames get no preload: the picker's shield, over the whole page,
  keeps the pointer from them. A cancelled pick (the page's Note picker took the page; a design
  pick never replaces it) ends the mode and removes its outlines. Keys are kept from the page by
  `BrowserHost.interceptInput` (`before-input-event`; Relay's own shortcuts pass; Esc ends the
  mode). Every change of the selection is read in the page, cropped and sent as
  `design.selection`; a 700 ms poll of a signature of the selected elements (node identity,
  attributes, size, key styles, text, and a count of DOM changes inside them) and `dom-ready`
  catch hot updates and reloads. Regions are cropped once, when dragged. Turning the mode on and
  off is serialized per tab.
- Page, `src/main/browser/design-page.ts`: the selection outlines live in a closed shadow root in
  an isolated world (`relay-design`), so the page's scripts and styles can't reach them; reads that
  need React's fibers run in the page's world, read-only. Crops are taken with the outlines and the
  picker hidden.
- Renderer: the mode is an XState machine (`src/renderer/browser/design/design-mode.machine.ts`,
  diagram in `docs/state-machines/design-mode.md`), one actor per page tab
  (`design-runtime.ts`); `DesignToggle`, `DesignInspector`, `DesignAnnotate`. Submit calls
  `design.send`: main (`design-send.ts`) writes the screenshots and builds the note, and the
  notes' sender (`agent-presence/notes.ts`) posts it. The composer chips (`design-chips.ts`,
  `composer/DesignChips.tsx`) ask `design.owner` which chat owns the page, show the selection in
  that chat's composer and, when its message is sent, call `design.compose` for the note text and
  screenshots to send with it. The inspector's dock (`design-dock.ts`) is a per-tab edge.

## Selectors

Each pick is saved two ways. The first is a CSS path checked to name that element alone when it is
made: a unique id, test id, aria-label or name when there is one, otherwise tag, classes and
`:nth-of-type`, falling back to an `:nth-child` chain from body (the change note carries this path;
`querySelectorAll(path).length` is 1). The second is a fingerprint (tag, text, its parent's text, a
few stable attributes, position among its siblings, size), which main keeps across reloads. After a
reload, hot update or re-render, the overlay weighs the element the path names alongside its
look-alikes (same tag and class, or the path without positions) against the fingerprint. Matching
text counts first, and a slightly edited text still counts as close. The single best match wins and
is given a fresh unique path. When several match equally well, or none matches, the element shows as
missing; it is never the first of several. (A page that shows one card while filtered gives that
card a path with no position; the fingerprint is what keeps it on the same card after the page
shows all six again.)

## Limits

- The crop is what the page shows: an element scrolled out of view has no screenshot (the prompt
  says so) and a partly visible one is cut at the viewport.
- A region is a screenshot taken when dragged: it is not outlined in the page and is not taken
  again after a reload or scroll.
- Opening the page's Note picker while the mode is on ends the mode (one picker per page).
- A page with no guest preload (another session's) gets the picker's own window capture
  listeners only: the page's window listeners added before the pick still see the pointer. The
  wheel always reaches the page, so it scrolls.
- `relay-design-input` is a document event: the page can listen to it (it sees where the pointer
  is and its buttons), stop it before the picker, or send fake ones, so it can change what is
  selected, nothing more (Isaac still reads the inspector and presses Send).
- Frames are kept from the pointer by the picker's shield only: after a reload or navigation,
  until the picker is back (at `dom-ready`, half a second later when a pick failed), a frame's
  page sees the pointer, as does a frame in a top-layer dialog drawn over the shield.
- The selection is found again by its selector path; a hot update that changes the element's
  classes or position past what the path names marks it "Not in the page right now".
- While a refresh crops, the outlines hide for a moment; a selected element whose content changes
  all the time (a ticking clock inside it) refreshes on every poll.

## Verify

- Unit: `pnpm vitest run src/main/browser/design-mode.test.ts src/main/browser/design-send.test.ts src/main/browser/annotate-picker.test.ts src/preload/design-gate.test.ts src/renderer/browser/design`
- Machine doc: `pnpm machines:docs` (CI fails when the diagram is stale)
- End to end (hidden window): `pnpm e2e:run e2e/design-mode.spec.ts`; `EVAOS_PROOF=1` writes the
  screenshots to `proof/phase-design-mode/`.
