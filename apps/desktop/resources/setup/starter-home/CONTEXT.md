# Home base: the shelf map

Where things live and how context loads. The idea (ICM, Interpretable Context Methodology): small routers, one home for each fact, and every assistant loads only what the current task needs. Entry point: `AGENTS.md`.

## Layers
| Layer | Files | Loads | Answers |
|---|---|---|---|
| L0 | `AGENTS.md` | at the start | who am I, where do I go |
| L1 | `memory/index.md` | at the start | what do I already know about {{userName}} |
| L2 | `workspaces/<name>.md` | when a task starts | what do I do here (its `## What to Load` table) |
| L3 | `references/*.md`, `workflows/*.md` | on demand | what rules and steps apply |
| L4 | `memory/journal.md`, `memory/todos.md`, `work/` | on demand | what is happening and what is open |

Lower layers are bigger and loaded less often. A card or router names exactly which lower files to read, so an assistant never has to read everything.

## Shelves
| Shelf | One job |
|---|---|
| `workspaces/` | one card per project, client or area of life (`workspaces/README.md`) |
| `workflows/` | runbooks: how to do a recurring task (`workflows/README.md`) |
| `references/` | stable facts and rules (`references/README.md`) |
| `memory/` | `index.md` (what loads at the start), `journal.md` (dated log), `todos.md` (open items) |
| `work/` | scratch and live state; ignored by git; safe to clear |
| `secrets/` | keys and tokens; ignored by git; never quoted in notes |
| `.omp/` | assistant setup: `assistant/` (who the assistants are), `templates/` (blank shapes), `tools/` (helper scripts) |

## Growing the home base
- New project or client: copy `.omp/templates/workspace.md` to `workspaces/<name>.md`.
- New recurring task: copy `.omp/templates/runbook.md` to `workflows/<task>.md`.
- Keep files small. When a card or runbook grows past a page, keep it as a router and move detail into a folder beside it.
- Change the file where the fact lives; never copy a fact into a second place, point to it.
