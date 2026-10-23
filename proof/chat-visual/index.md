# Chat visual bench

Screenshots of the chat view rendering the gallery session
(`fixtures/agent-gallery`), written by `apps/desktop/e2e/chat-visual.spec.ts`.
Rerun from the repo root:

```sh
source scripts/env.sh
pnpm -C apps/desktop exec electron-vite build
pnpm -C apps/desktop exec playwright test e2e/chat-visual.spec.ts
```

Unless a name says otherwise: Settings > Chat has Show thinking and Show tool details on,
the side panel is closed, and motion is off.

| File | State |
| --- | --- |
| [bench-gallery-dark-bottom.png](bench-gallery-dark-bottom.png) | Test Bench > Chat gallery frame, transcript at the bottom, dark |
| [bench-gallery-dark-card-ask-multi.png](bench-gallery-dark-card-ask-multi.png) | Test Bench gallery with the ask, two questions card, dark |
| [bench-gallery-dark-card-dead.png](bench-gallery-dark-card-dead.png) | Test Bench gallery with the unanswerable question card, dark |
| [bench-gallery-dark-card-editor.png](bench-gallery-dark-card-editor.png) | Test Bench gallery with the editor card, dark |
| [bench-gallery-dark-middle.png](bench-gallery-dark-middle.png) | Test Bench > Chat gallery frame, transcript at the middle, dark |
| [bench-gallery-dark-page.png](bench-gallery-dark-page.png) | Test Bench > Chat gallery, top of the page with its controls, dark |
| [bench-gallery-dark-toggles-off.png](bench-gallery-dark-toggles-off.png) | Test Bench gallery with its Show thinking and Show tool details switches off, dark |
| [bench-gallery-dark-top.png](bench-gallery-dark-top.png) | Test Bench > Chat gallery frame, transcript at the top, dark |
| [bench-gallery-light-bottom.png](bench-gallery-light-bottom.png) | Test Bench > Chat gallery frame, transcript at the bottom, light |
| [bench-gallery-light-card-ask-multi.png](bench-gallery-light-card-ask-multi.png) | Test Bench gallery with the ask, two questions card, light |
| [bench-gallery-light-card-dead.png](bench-gallery-light-card-dead.png) | Test Bench gallery with the unanswerable question card, light |
| [bench-gallery-light-card-editor.png](bench-gallery-light-card-editor.png) | Test Bench gallery with the editor card, light |
| [bench-gallery-light-middle.png](bench-gallery-light-middle.png) | Test Bench > Chat gallery frame, transcript at the middle, light |
| [bench-gallery-light-page.png](bench-gallery-light-page.png) | Test Bench > Chat gallery, top of the page with its controls, light |
| [bench-gallery-light-toggles-off.png](bench-gallery-light-toggles-off.png) | Test Bench gallery with its Show thinking and Show tool details switches off, light |
| [bench-gallery-light-top.png](bench-gallery-light-top.png) | Test Bench > Chat gallery frame, transcript at the top, light |
| [card-dark-ask-multi.png](card-dark-ask-multi.png) | Ask card, two questions, the second multi choice, dark |
| [card-dark-ask.png](card-dark-ask.png) | Ask card, one question with four numbered options, dark |
| [card-dark-confirm.png](card-dark-confirm.png) | Confirm card, dark |
| [card-dark-dead-and-error-banner.png](card-dark-dead-and-error-banner.png) | omp exited unexpectedly: dead question card and the error banner, dark |
| [card-dark-editor.png](card-dark-editor.png) | Editor card with prefilled text, dark |
| [card-dark-input.png](card-dark-input.png) | Input card, dark |
| [card-dark-select.png](card-dark-select.png) | Select card (extension UI) with option details, dark |
| [card-light-ask-multi.png](card-light-ask-multi.png) | Ask card, two questions, the second multi choice, light |
| [card-light-ask.png](card-light-ask.png) | Ask card, one question with four numbered options, light |
| [card-light-confirm.png](card-light-confirm.png) | Confirm card, light |
| [card-light-dead-and-error-banner.png](card-light-dead-and-error-banner.png) | omp exited unexpectedly: dead question card and the error banner, light |
| [card-light-editor.png](card-light-editor.png) | Editor card with prefilled text, light |
| [card-light-input.png](card-light-input.png) | Input card, light |
| [card-light-select.png](card-light-select.png) | Select card (extension UI) with option details, light |
| [composer-dark-drop-overlay.png](composer-dark-drop-overlay.png) | Composer while an image is dragged over it, dark |
| [composer-dark-focused-text.png](composer-dark-focused-text.png) | Composer focused with two lines of text, dark |
| [composer-dark-image-attached.png](composer-dark-image-attached.png) | Composer with text and one pasted image chip, dark |
| [composer-dark-notice.png](composer-dark-notice.png) | Composer notice after dropping a text file, dark |
| [composer-light-drop-overlay.png](composer-light-drop-overlay.png) | Composer while an image is dragged over it, light |
| [composer-light-focused-text.png](composer-light-focused-text.png) | Composer focused with two lines of text, light |
| [composer-light-image-attached.png](composer-light-image-attached.png) | Composer with text and one pasted image chip, light |
| [composer-light-notice.png](composer-light-notice.png) | Composer notice after dropping a text file, light |
| [defaults-dark-1280x800-bottom.png](defaults-dark-1280x800-bottom.png) | Gallery with the default switches (thinking hidden, tool runs folded), dark, transcript at the bottom |
| [defaults-dark-1280x800-middle.png](defaults-dark-1280x800-middle.png) | Gallery with the default switches (thinking hidden, tool runs folded), dark, transcript at the middle |
| [defaults-light-1280x800-bottom.png](defaults-light-1280x800-bottom.png) | Gallery with the default switches (thinking hidden, tool runs folded), light, transcript at the bottom |
| [defaults-light-1280x800-middle.png](defaults-light-1280x800-middle.png) | Gallery with the default switches (thinking hidden, tool runs folded), light, transcript at the middle |
| [expanded-dark-1280x800-bottom.png](expanded-dark-1280x800-bottom.png) | Gallery, dark, every visible folded tool run expanded, transcript at the bottom |
| [expanded-dark-1280x800-middle.png](expanded-dark-1280x800-middle.png) | Gallery, dark, every visible folded tool run expanded, transcript at the middle |
| [expanded-dark-1280x800-top.png](expanded-dark-1280x800-top.png) | Gallery, dark, every visible folded tool run expanded, transcript at the top |
| [expanded-light-1280x800-bottom.png](expanded-light-1280x800-bottom.png) | Gallery, light, every visible folded tool run expanded, transcript at the bottom |
| [expanded-light-1280x800-middle.png](expanded-light-1280x800-middle.png) | Gallery, light, every visible folded tool run expanded, transcript at the middle |
| [expanded-light-1280x800-top.png](expanded-light-1280x800-top.png) | Gallery, light, every visible folded tool run expanded, transcript at the top |
| [gallery-dark-1280x800-bottom.png](gallery-dark-1280x800-bottom.png) | Gallery chat, dark, 1280x800, transcript scrolled to the bottom (header shows Saved session) |
| [gallery-dark-1280x800-middle.png](gallery-dark-1280x800-middle.png) | Gallery chat, dark, 1280x800, transcript scrolled to the middle (Jump to latest pill) |
| [gallery-dark-1280x800-top.png](gallery-dark-1280x800-top.png) | Gallery chat, dark, 1280x800, transcript scrolled to the top (Jump to latest pill) |
| [gallery-dark-1440x900-panel-bottom.png](gallery-dark-1440x900-panel-bottom.png) | Gallery chat, dark, 1440x900 with the browser panel open, transcript scrolled to the bottom (header shows Saved session) |
| [gallery-dark-1440x900-panel-middle.png](gallery-dark-1440x900-panel-middle.png) | Gallery chat, dark, 1440x900 with the browser panel open, transcript scrolled to the middle (Jump to latest pill) |
| [gallery-dark-1440x900-panel-top.png](gallery-dark-1440x900-panel-top.png) | Gallery chat, dark, 1440x900 with the browser panel open, transcript scrolled to the top (Jump to latest pill) |
| [gallery-dark-900x800-bottom.png](gallery-dark-900x800-bottom.png) | Gallery chat, dark, 900x800, transcript scrolled to the bottom (header shows Saved session) |
| [gallery-dark-900x800-middle.png](gallery-dark-900x800-middle.png) | Gallery chat, dark, 900x800, transcript scrolled to the middle (Jump to latest pill) |
| [gallery-dark-900x800-top.png](gallery-dark-900x800-top.png) | Gallery chat, dark, 900x800, transcript scrolled to the top (Jump to latest pill) |
| [gallery-light-1280x800-bottom.png](gallery-light-1280x800-bottom.png) | Gallery chat, light, 1280x800, transcript scrolled to the bottom (header shows Saved session) |
| [gallery-light-1280x800-middle.png](gallery-light-1280x800-middle.png) | Gallery chat, light, 1280x800, transcript scrolled to the middle (Jump to latest pill) |
| [gallery-light-1280x800-top.png](gallery-light-1280x800-top.png) | Gallery chat, light, 1280x800, transcript scrolled to the top (Jump to latest pill) |
| [gallery-light-1440x900-panel-bottom.png](gallery-light-1440x900-panel-bottom.png) | Gallery chat, light, 1440x900 with the browser panel open, transcript scrolled to the bottom (header shows Saved session) |
| [gallery-light-1440x900-panel-middle.png](gallery-light-1440x900-panel-middle.png) | Gallery chat, light, 1440x900 with the browser panel open, transcript scrolled to the middle (Jump to latest pill) |
| [gallery-light-1440x900-panel-top.png](gallery-light-1440x900-panel-top.png) | Gallery chat, light, 1440x900 with the browser panel open, transcript scrolled to the top (Jump to latest pill) |
| [gallery-light-900x800-bottom.png](gallery-light-900x800-bottom.png) | Gallery chat, light, 900x800, transcript scrolled to the bottom (header shows Saved session) |
| [gallery-light-900x800-middle.png](gallery-light-900x800-middle.png) | Gallery chat, light, 900x800, transcript scrolled to the middle (Jump to latest pill) |
| [gallery-light-900x800-top.png](gallery-light-900x800-top.png) | Gallery chat, light, 900x800, transcript scrolled to the top (Jump to latest pill) |
| [images-dark-1280x800-user-thumbnails.png](images-dark-1280x800-user-thumbnails.png) | Gallery, dark: user message with a blob store image and an inline image, then the browse tool row with its screenshot |
| [images-dark-1280x800-viewer.png](images-dark-1280x800-viewer.png) | Image viewer opened on a chat image, dark |
| [images-light-1280x800-user-thumbnails.png](images-light-1280x800-user-thumbnails.png) | Gallery, light: user message with a blob store image and an inline image, then the browse tool row with its screenshot |
| [images-light-1280x800-viewer.png](images-light-1280x800-viewer.png) | Image viewer opened on a chat image, light |
| [live-dark-after-reply.png](live-dark-after-reply.png) | Reply finished, omp still running (no Saved session pill), dark |
| [live-dark-jobs-strip-open.png](live-dark-jobs-strip-open.png) | Jobs strip expanded while omp runs, dark |
| [live-dark-jump-pill.png](live-dark-jump-pill.png) | Scrolled up after the reply: Jump to latest pill, dark |
| [live-dark-new-reply-pill.png](live-dark-new-reply-pill.png) | Scrolled up while Eva streams: New reply pill, dark |
| [live-dark-reconnecting.png](live-dark-reconnecting.png) | Header while the stream resyncs (Reconnecting to the stream.), dark |
| [live-dark-streaming.png](live-dark-streaming.png) | Eva replying: streaming dot, Stop button, jobs strip and subagent chips, dark |
| [live-dark-subagent-popover.png](live-dark-subagent-popover.png) | Running subagent chip popover with its last line, dark |
| [live-light-after-reply.png](live-light-after-reply.png) | Reply finished, omp still running (no Saved session pill), light |
| [live-light-jobs-strip-open.png](live-light-jobs-strip-open.png) | Jobs strip expanded while omp runs, light |
| [live-light-jump-pill.png](live-light-jump-pill.png) | Scrolled up after the reply: Jump to latest pill, light |
| [live-light-new-reply-pill.png](live-light-new-reply-pill.png) | Scrolled up while Eva streams: New reply pill, light |
| [live-light-reconnecting.png](live-light-reconnecting.png) | Header while the stream resyncs (Reconnecting to the stream.), light |
| [live-light-streaming.png](live-light-streaming.png) | Eva replying: streaming dot, Stop button, jobs strip and subagent chips, light |
| [live-light-subagent-popover.png](live-light-subagent-popover.png) | Running subagent chip popover with its last line, light |
| [new-chat-dark-1280x800.png](new-chat-dark-1280x800.png) | New chat empty state, dark |
| [new-chat-dark-900x800.png](new-chat-dark-900x800.png) | New chat empty state at 900 px, dark |
| [new-chat-light-1280x800.png](new-chat-light-1280x800.png) | New chat empty state, light |
| [new-chat-light-900x800.png](new-chat-light-900x800.png) | New chat empty state at 900 px, light |
| [owned-light-header.png](owned-light-header.png) | Header when another pane runs omp for this chat |
| [owned-light-writer-prompt.png](owned-light-writer-prompt.png) | Writer prompt: confirm before writing into a chat another pane owns |
| [settings-chat-dark-toggles-off.png](settings-chat-dark-toggles-off.png) | Settings > Chat with Show thinking and Show tool details off, dark |
| [settings-chat-light-toggles-off.png](settings-chat-light-toggles-off.png) | Settings > Chat with Show thinking and Show tool details off, light |
| [toggles-off-dark-1280x800-bottom.png](toggles-off-dark-1280x800-bottom.png) | Gallery with thinking hidden and tool runs folded into "Used N tools" lines, dark, transcript at the bottom |
| [toggles-off-dark-1280x800-middle.png](toggles-off-dark-1280x800-middle.png) | Gallery with thinking hidden and tool runs folded into "Used N tools" lines, dark, transcript at the middle |
| [toggles-off-dark-1280x800-tool-run-open.png](toggles-off-dark-1280x800-tool-run-open.png) | Folded tool runs, dark, the visible runs opened to their calls |
| [toggles-off-dark-1280x800-top.png](toggles-off-dark-1280x800-top.png) | Gallery with thinking hidden and tool runs folded into "Used N tools" lines, dark, transcript at the top |
| [toggles-off-light-1280x800-bottom.png](toggles-off-light-1280x800-bottom.png) | Gallery with thinking hidden and tool runs folded into "Used N tools" lines, light, transcript at the bottom |
| [toggles-off-light-1280x800-middle.png](toggles-off-light-1280x800-middle.png) | Gallery with thinking hidden and tool runs folded into "Used N tools" lines, light, transcript at the middle |
| [toggles-off-light-1280x800-tool-run-open.png](toggles-off-light-1280x800-tool-run-open.png) | Folded tool runs, light, the visible runs opened to their calls |
| [toggles-off-light-1280x800-top.png](toggles-off-light-1280x800-top.png) | Gallery with thinking hidden and tool runs folded into "Used N tools" lines, light, transcript at the top |
| [tools-dark-1280x800-verbose.png](tools-dark-1280x800-verbose.png) | Show tool details on, dark: each call's header, input and clipped output |
| [tools-light-1280x800-verbose.png](tools-light-1280x800-verbose.png) | Show tool details on, light: each call's header, input and clipped output |

## Native EvaOS reference

| File | State |
| --- | --- |
| [native/evaos-native-chat-1813x900.png](native/evaos-native-chat-1813x900.png) | The running native EvaOS app (Rust), a window screenshot for comparison |
