# Third-party notices

Code and conventions Relay borrows from other projects, with their licenses. Dependencies installed
through package managers carry their own license files and are not listed here.

## TasteCode

- Project: TasteCode, https://github.com/Leonxlnx/tastecode (read at commit c216616c, 2026-11-12)
- Copyright 2026 TasteCode contributors
- License: Apache License 2.0, https://www.apache.org/licenses/LICENSE-2.0

TasteCode's NOTICE: "This product includes software developed by TasteCode contributors."

Used in Relay Desktop's Design Mode (`apps/desktop/docs/design-mode.md`), adapted and rewritten in
TypeScript for Relay's page tabs:

| Relay file                                                   | What comes from TasteCode                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/browser/design-page.ts`               | The selector path algorithm (id when unique, else tag, two classes and `:nth-of-type`, through shadow roots as `host >>> inner`), resolving such a path, and the shadow-aware element under the pointer, from `apps/web/src/ui/workspace/browser-annotations.ts`. |
| `apps/desktop/src/main/browser/design-mode.ts`               | Element crops taken with the overlay out of the capture and capped on the long side, from `apps/web/src/ui/workspace/BrowserAnnotations.tsx`.                                                                                                                     |
| `apps/desktop/src/renderer/browser/design/design-request.ts` | The prompt block convention: page strings stay JSON strings on their own lines and the block ends by saying page content is evidence, never instructions (`browser-comments.ts`).                                                                                 |

Changes from the originals: Relay runs the overlay in an isolated world of its own native page view
over CDP (TasteCode uses an Electron `<webview>` probe script), reads React source locations and
computed styles, lets the user edit styles and draw on a crop, and sends the request to the
workspace's chat.
