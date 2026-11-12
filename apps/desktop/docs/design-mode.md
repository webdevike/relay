# Design Mode

Point at elements of a page in a Relay page tab, say what should change, and send it to the
workspace's chat; the agent edits the code, the page hot-reloads and the selection stays. Built for
local dev pages (`localhost:5173`, a port such as `3000` in the address field); it works on any page.
Inspired by TasteCode's browser annotations (Apache-2.0, see `THIRD_PARTY_NOTICES.md`).

## Try it

1. Open a chat, open a page tab beside it (+ in a tool pane, then Browser) and load your dev server.
2. Press the pointer button at the right of the address row (`btn-design-mode`). The inspector
   opens beside the page (under it when the pane is narrower than 720 px).
3. Hover: the element under the pointer gets a quiet outline and its tag. Clicks, hovers and keys
   (typing, paste, the page's own shortcuts) stay out of the page while the mode is on; Relay's
   shortcuts still work and the wheel still scrolls the page.
4. Click to select; Shift-click adds or removes one (up to 8). Each selected element keeps a
   numbered outline.
5. In the inspector: the element (`button#save`), its component and source `file:line`, its
   screenshot and computed styles. Edit a style value (Enter or leaving the field previews it in
   the page; the undo arrow puts it back; a value CSS does not take is refused with the reason).
   "Draw on it" opens the screenshot to mark it with a pen.
6. Describe the change ("8px tighter") and press Send (Cmd+Enter in the field). It goes to the chat
   that owns the page (the chat of its workspace, or the chat whose agent drives it) as your own
   message, a page note of intent `change` (`docs/agent-presence.md`): every element's selector,
   DOM, source, component, computed styles, your style edits and its screenshot (a drawn one in
   place of the plain crop), saved under `<configDir>/notes/` and attached as images. A page of a
   new chat not started yet has no owner: Send says so.
7. The page reloads or hot-updates: the selection is found again by selector and the inspector
   refreshes.
8. Esc (in the page or in Relay) or the toggle ends the mode. Leaving the site or closing the tab
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
- Main, `src/main/browser/design-mode.ts`: one session per page tab. Input from Isaac's mouse is
  taken from the page through `BrowserHost.interceptInput` (`before-mouse-event`, which carries
  no modifiers: Shift comes from the last key event in the page or the shell). Every change of the
  selection is read in the page, cropped and sent as `design.selection`; a 700 ms poll of a
  signature of the selected elements (node identity, attributes, size, key styles, text, and a
  count of DOM changes inside them) and `dom-ready` catch hot updates and reloads. Turning the
  mode on and off is serialized per tab.
- Page, `src/main/browser/design-page.ts`: the highlight lives in a closed shadow root in an
  isolated world (`relay-design`), so the page's scripts and styles can't reach it; reads that need
  React's fibers run in the page's world, read-only. Crops are taken with the highlight hidden.
- Renderer: the mode is an XState machine (`src/renderer/browser/design/design-mode.machine.ts`,
  diagram in `docs/state-machines/design-mode.md`), one actor per page tab
  (`design-runtime.ts`); `DesignToggle`, `DesignInspector`, `DesignAnnotate`. Send calls
  `design.send`: main (`design-send.ts`) writes the screenshots and builds the note, and the
  notes' sender (`agent-presence/notes.ts`) posts it.

## Limits

- The crop is what the page shows: an element scrolled out of view has no screenshot (the prompt
  says so) and a partly visible one is cut at the viewport.
- Hover costs one CDP call per mouse move (moves arriving meanwhile are coalesced).
- The selection is found again by its selector path; a hot update that changes the element's
  classes or position past what the path names marks it "Not in the page right now".
- While a refresh crops, the outlines hide for a moment; a selected element whose content changes
  all the time (a ticking clock inside it) refreshes on every poll.

## Verify

- Unit: `pnpm vitest run src/main/browser/design-mode.test.ts src/main/browser/design-send.test.ts src/renderer/browser/design`
- Machine doc: `pnpm machines:docs` (CI fails when the diagram is stale)
- End to end (hidden window): `pnpm e2e:run e2e/design-mode.spec.ts`; `EVAOS_PROOF=1` writes the
  screenshots to `proof/phase-design-mode/`.
