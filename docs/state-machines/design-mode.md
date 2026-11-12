# Design Mode in a page tab (desktop)

Design Mode in one page tab of Relay Desktop (`apps/desktop/src/renderer/browser/design/design-mode.machine.ts`, run per tab by `design-runtime.ts`; the page side is `apps/desktop/src/main/browser/design-mode.ts`). `starting` and `stopping` ask main to turn the in-page highlight and input capture on or off; a page main can't reach goes back to `off` with the reason. Main's events come in as `page.selection` (a click, or the page changing the selection itself), `design.exit` (Escape, from the page or the inspector) and `page.left` (the tab went to another site or closed, so main already ended it).

- **picking**: on, nothing selected yet; hovering highlights, a click selects.
- **selected.editing**: the inspector shows the selection; Isaac types a change, edits a style value (previewed in the page) or opens a crop to draw on. Send needs at least one element that is in the page and a change, a style edit or a drawing.
- **drawing**: one element's crop is open to draw on; Done puts the drawing in place of that crop in the request.
- **sending**: the prompt goes to the workspace's chat, once; a failure goes back to editing with the request intact.
- **selected.sent**: it went; the selection stays and follows the page as the agent's edit hot-reloads it. Any new change goes back to editing.

<!-- diagram:start (generated from the machine by `pnpm machines:docs`; do not edit) -->
```mermaid
stateDiagram-v2
  [*] --> off
  state on {
    [*] --> on_picking
    state "picking" as on_picking
    state "selected" as on_selected
    state on_selected {
      [*] --> on_selected_editing
      state "editing" as on_selected_editing
      state "sent" as on_selected_sent
    }
    state "drawing" as on_drawing
    state "sending" as on_sending
  }
  off --> starting : design.toggle
  starting --> stopping : design.toggle
  starting --> stopping : design.exit
  starting --> off : page.left
  starting --> on : done setMode
  starting --> off : error setMode
  on --> stopping : design.toggle
  on --> stopping : design.exit
  on --> off : page.left
  on_picking --> on_selected : page.selection [hasItems]
  on_picking --> on_selected : always [hasSelection]
  on_selected --> on_picking : page.selection
  on_selected --> on_selected_editing : instruction.change
  on_selected --> on_selected_editing : style.edit [validStyle]
  on_selected --> on_drawing : draw.open [hasCrop]
  on_selected_editing --> on_sending : request.send [guard]
  on_selected_editing --> on_sending : always [guard]
  on_drawing --> on_selected : page.selection [hasItems]
  on_drawing --> on_picking : page.selection
  on_drawing --> on_selected : draw.done
  on_drawing --> on_selected : draw.cancel
  on_sending --> on_selected_sent : done sendRequest
  on_sending --> on_selected : error sendRequest
  stopping --> off : done setMode
  stopping --> off : error setMode
```
<!-- diagram:end -->
