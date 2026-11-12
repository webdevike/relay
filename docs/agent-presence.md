# Agent presence: one way an agent works in front of Isaac

A chat's agent (Nova in her thread, Eva in a plain chat, any omp session) works the surfaces Isaac
sees the same way on each: its face, a soft ring of its color, one caption line, a cursor that
travels to each change, and a one-row work card in its chat. Isaac keeps talking to the agent in
that chat; what he marks on the surface comes back into the same chat as his message. Surfaces
today: a web page in the shared browser and a canvas board. Relay Assist's screen overlay is meant
to join the same layer.

## Pieces

| Piece                                   | Where                                                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Run contract (`AgentRun`, `AgentRunOp`) | `packages/contract/src/agent-presence.ts`                                                                         |
| Run lifecycle (XState)                  | `packages/shell-core/src/agent-run.machine.ts`, docs/state-machines/agent-run.md                                  |
| Runs per surface key (main)             | `apps/desktop/src/main/agent-presence/agent-runs.ts` (`AgentRuns<K, W>`)                                          |
| Cursor drawing (route, glide, trail)    | `packages/shell-core/src/agent-cursor.ts`: a page gets it in an isolated world, a board mounts it over React Flow |
| Browser drive                           | `main/browser/agent-drive.ts` (`browser.*` actions, tab key)                                                      |
| Canvas drive                            | `main/canvas/agent-canvas.ts` + `board-edit.ts` (`canvas.*` actions, board slug key)                              |
| Notes to the chat                       | `main/agent-presence/notes.ts` (`agent.note`), `main/browser/annotate.ts` (`browser.annotate`)                    |
| Chat card                               | `renderer/chat/strips/AgentWorkCards.tsx` (pages and boards)                                                      |

## Canvas drive

`canvas.open` shows the board on the Canvas page in the caller's workspace (`tab.open` page
canvas), switches it to the run's page (`page` board call) and starts the run keyed by slug. A
board's actions run one at a time, in the order they came. Each write action runs the same steps:

1. `runs.admit` refuses `paused-by-isaac`, `busy` (another chat's run mid-way: a run belongs to
   its chat's workspace, so two plain chats that both show as Eva are told apart) or
   `awaiting-approval`, before anything changes; then the run begins and the action notes its
   epoch.
2. `reveal` brings the work (the cards it touches, a new card's spot) into view clear of the
   board's chrome, panning the least it can and zooming a board zoomed out past reading up to
   1 (100%); the cards around it (a link's other end, a moved card's new spot) show too only
   when they fit at nearly that zoom. In a long move the board pans in the carry's own easing,
   so the card and cursor stay on screen; a carry taken back restores the view it began from.
   The agent moving the view ends the board's own settling fit.
3. The cursor travels: main calls the renderer's `@canvas` with a `CanvasBoardCall`
   (`cursor` move with a lead for the dotted route, then `click`; `drag` for a move) and waits the
   `ms` the board answers. Targets are a card id plus anchor or a board point, in flow units; the
   board turns them into screen points at its current viewport.
4. Every step checks the run is still working in the epoch the action began in: once Isaac takes
   over (even if he hands back before the action wakes) or the run ends, nothing more lands
   (`paused-by-isaac`, `stopped`).
5. `flush` saves the board's pending local edits, then `store.update` reads the page from
   `<slug>.json`, applies the pure edit (`board-edit.ts`) and writes it as one queued step no
   other save of the board lands inside, and emits `canvas.changed`; the open board reloads at
   once, so the card appears under the cursor. The epoch check runs again at the commit (the
   temp file staged, right before the rename), so a Take over during the write keeps the file.
   A card the agent carries saves at its old spot until main's write lands it (`landed`); a hide
   before that puts it back.

A board not on screen answers `mounted: false`: main skips the cursor and still writes the file.
Hiding the cursor (Take over, done) reaches every mounted board of the slug, so a board shown
again later has no stale cursor.
Runs publish as `canvas.runs` (contract `CanvasRun`: the run plus slug, board, page and the
driving chat's `workspace`). The board's caption row sends `canvas.agent` (Take over, Hand back,
dismiss); Isaac's own edits on the board (and his own pan, zoom or page switch) send Take over
while the run is working.

## Notes to the chat

Board comments (click a card, `/` or Comment) are saved in the board's thread as before, then sent
with `agent.note`; the Note button on a web page (`browser.annotate`) marks an element or a dragged
region (the page only draws the mark), takes the note in the shell in place of the page's address
row (`renderer/browser/NoteComposer.tsx`, `browser.annotateSend`; a field inside the page would
show the page's own key listeners every key), writes a PNG crop to `<configDir>/notes/` and sends
it the same way. A mark is bound to its page: a navigation (in-page too) or the page going away
drops it (`browser.annotateDropped` closes the composer; `annotateSend` fails `page-changed`).
Design Mode's Send (`apps/desktop/docs/design-mode.md`, `design.send`) is a page note too, of
intent `change`: the same sender and owner, with what it read of each selected element (source,
component, DOM, computed styles, Isaac's style edits; more elements under `also`) and one
screenshot per element.
The owner is, in order:
the assistant a comment @mentions, the chat whose agent runs on that surface (its run's
`workspace`), the chat of the workspace the surface is shown in. `chat:<file>` posts through the
pane showing that chat (or Relay when it runs elsewhere); `page:agent:<id>` posts an
`assistant.turn`. The text (`noteText`) names the spot and links back
(`relay://open/canvas?canvas=<slug>&node=<id>`, or the page URL and screenshot path). The agent
answers in the chat and may mirror a short answer under a board comment with `canvas.reply`.

The older live room (`canvas.live`, `relay-linux canvas start`) keeps its own canvas self and its
room iframe; it is for the phone, a browser joining, or several agents on one board.
