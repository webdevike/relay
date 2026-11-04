# Agent access: coverage matrix

What an agent (any omp session, an assistant like Nova) can **read**, **change** and **deep-link**
in Relay Desktop, through `relay-ctl` (CLI, `.omp/tools/relay-ctl.ts`) and `relay-mcp` (stdio MCP,
`.omp/tools/relay-mcp.ts`, registered as `relay` in Eva's `.omp/mcp.json`). Both speak the same
loopback agent control API; the action registry is `agentActions` in
`packages/contract/src/agent.ts`, the access layer (pages, settings, connections, links, tour) is
`packages/contract/src/agent-access.ts`.

Legend: **R** read, **C** change, **L** relay:// deep link. "before" is main at f7ce63bc.

| Place                                                        | Before (R / C / L)                                                         | After (R / C / L)                                                                                                                            | How                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Any page: what is on screen                                  | state.read (raw JSON) / - / -                                              | `describe` (plain text + page, selection, panes, tour targets)                                                                               | renderer `describe`                 |
| Page catalog                                                 | -                                                                          | `pages.list` (every page, its link, actions)                                                                                                 | main                                |
| Dashboard, Assistants, Jobs, Habits, Rooms, Setup            | R (state) / C (page.open) / L (`relay://open/<page>`)                      | same, plus describe                                                                                                                          |                                     |
| Assistant thread `agent:<id>`                                | R / C / L (`relay://assistant/<id>`)                                       | same                                                                                                                                         |                                     |
| Chat                                                         | R / C (chat.open, chat.new, chat.start destructive) / L page only          | same                                                                                                                                         |                                     |
| Test Bench                                                   | R / C (testbench.open) / -                                                 | L `relay://open/test-bench?experiment=&arm=`                                                                                                 | link, link.open                     |
| Meetings                                                     | R / C / -                                                                  | L `?meeting=`                                                                                                                                |                                     |
| Canvas, boards                                               | R / C (page.open, canvas.live) / L page only                               | L `relay://open/canvas?canvas=<slug>`, `relay://open/board/<slug>`                                                                           |                                     |
| Studio                                                       | R (studio.list) / C (studio.generate free, studio.open) / L page           | L `?job=<id>`                                                                                                                                |                                     |
| Reviews                                                      | R / C (page.open item) / L page (desktop), `relay://reviews?item=` (phone) | L `relay://open/reviews?item=<url>` on both                                                                                                  |                                     |
| Workspace `workspace:<slug>`                                 | R / C / -                                                                  | L `relay://open/workspace/<slug>`                                                                                                            |                                     |
| Panes, tool tabs (Browser, Files, Terminal, Artifacts, arms) | R (layout.read) / C (pane._, tab._, files.open, browser.*) / -             | same (no link: panes are window layout)                                                                                                      |                                     |
| Settings > Theme: preset, light/dark                         | R raw / - / L section only                                                 | R/C `theme.preset`, `theme.mode` with toast + Undo / L `?setting=`                                                                           | settings.get/set/undo               |
| Settings > Theme: colors, primary, radius, scale, font       | -                                                                          | R/C `theme.colors.<light/dark>.<slot>` (#rrggbb), `theme.primaryColor`, `theme.radius`, `theme.scale`, `theme.fontFamily`                    |                                     |
| Settings > Theme editor save / save as / delete              | -                                                                          | - (Isaac's: agent edits are unsaved until he saves)                                                                                          | gap, by design                      |
| Settings > Chat                                              | -                                                                          | R/C `chat.showThinking`, `chat.showTools`, `chat.harness`                                                                                    |                                     |
| Settings > Links (link rules)                                | -                                                                          | R via describe only / -                                                                                                                      | gap: rules editor not exposed       |
| Settings > Connections (new)                                 | did not exist                                                              | R `connections.list`, C `connections.add` (Linear key; others answer a sign-in link), `connections.remove` (destructive) / L `?connect=<id>` | main/connections                    |
| Settings > Setup, About, Changelog                           | R (state) / C page.open / L section only (Setup missing from enum)         | L `relay://open/settings/<section>` for all 7                                                                                                |                                     |
| Hosts / pairing                                              | -                                                                          | R relay-host row in connections; add answers the Setup link                                                                                  | pairing UI lives on eva/pin-pairing |
| Sidebar customization                                        | not on main (eva/sidebar-customize)                                        | -                                                                                                                                            | gap                                 |
| Update channel                                               | not on main (eva/desktop-self-update)                                      | -                                                                                                                                            | gap                                 |
| Tour                                                         | -                                                                          | `tour.highlight` (spotlight + caption + step), `tour.clear`                                                                                  | renderer tour/                      |
| relay:// in chat                                             | widgets only; markdown stripped the scheme                                 | desktop: `[label](relay://...)` and bare URLs render as buttons; phone: links and bare URLs open in app                                      | Markdown, AppLink                   |
| relay:// from outside the app                                | -                                                                          | packaged app registers the scheme (electron-builder `protocols`, `open-url`)                                                                 | main/deep-links.ts                  |

## Deep link grammar

`relay://assistant/<id>` or `relay://open/<page>[/<sub>][?<param>=<value>&...]`, params from
`item, setting, connect, canvas, meeting, experiment, arm, job`. `parseAppLink` / `buildAppLink`
live in `@evaos/chat-core/widget` and `@relay/protocol` (same grammar, tested both ways).
`link` builds one from `{page, section, setting, connection, item, ...}` and answers
`{url, label, markdown}`. `relay://open/setting` (singular) is read as `settings`; a link that names
no place shows a "no place for that link" toast instead of doing nothing.

## Which Mac

Agents run on the Mini; Isaac may be on the MacBook (a thin client of the Mini's Relay Host).
relay-ctl and relay-mcp send every action to `--device active` by default (relay-mcp: a `device`
argument on each tool, `relay_devices` lists them): the Mini's Relay Host forwards it
(`POST /control/run`, apps/linux README "Remote control") to the desktop Isaac used last, the
Mini's own app while none has been used, and that desktop runs it exactly like a local request.
`--device <id or name>` picks one, `--device local` skips the host. Toasts (Undo, approvals,
"waiting for you to finish typing") show on the Mac that ran the action.

## Rules

- Settings changes: ask Isaac first. Every agent change shows "<Agent> changed <setting> to <value> · Undo"; `settings.undo` and the toast's Undo put it back.
- Secrets are write-only: a Linear key goes to `<configDir>/connections/linear.env` (0600) and is never returned; lists say only where a key comes from.
- Sign-ins Isaac must do (GitHub device code, Claude/ChatGPT browser sign-in, pairing) come back as `needs-user` with the deep link to the row that runs them.
- GitHub, omp and Linear are only probed in the live app; test and dev instances report "Not checked".
