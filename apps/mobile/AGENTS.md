# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# Widgets are composed from shared primitives (Isaac, 2026-10-06)

Never build a ```ui widget (or any screen element) as a one-off. Break it into base elements in
`src/ui/` (and helpers in `src/lib/`), then have the widget in `src/agents/` only orchestrate them.
Before writing UI, check what already exists and reuse it; if a piece is missing, add it as a
primitive first, then use it.

Every ```ui widget must also render in EvaOS, Eva's desktop app (`~/Eva/apps/evaos/src/rich/widgets.rs`,
Rust/GPUI). Adding or changing a widget spec here means the same change there, with a parser test on
each side; see the `relay-widgets` skill.

Current primitives:

- Links: `lib/links.ts` `openExternal`, `ui/LinkButton.tsx` (text / icon / overlay). Never call `Linking.openURL` from a widget.
- Pagination: `ui/Pager.tsx` (`usePager`, `Pager`), `ui/PageControls.tsx` (`PageStepper`, `PageCounter`, `PageDots`). Never hand-roll a paging `ScrollView` or chevrons.
- Media: `ui/ImageFrame.tsx`, `ui/VideoFrame.tsx` (aspect-sized `expo-video` surface, center play, spinner, full-screen corner button), `ui/MediaTransport.tsx` (`MediaTransport` row plus `PlayButton`, `SeekBar`; shared by audio and video, times via `lib/format.ts` `mediaClock`), `ui/MediaPlaceholder.tsx` (host-not-connected and failed states), `ui/ImageCaption.tsx`, `ui/OverlayTag.tsx` (corner labels/badges on media), `agents/ZoomableImage.tsx` (pinch/pan/double-tap), `agents/ImageViewer.tsx` (full-screen pager).
- 3D: `ui/ModelView.tsx` (sized frame around the native glTF view in `modules/model-view`, SceneKit + GLTFKit2: fit to frame, drag orbits, pinch zooms, optional spin, spinner while loading, placeholder on failure). Never put a web view or three.js in a widget for 3D.
- Tones: `theme.ts` `ToneToken`, `toneFill` (low-alpha tone surface, raised surface for muted), `withAlpha`; `agents/tone.ts` `toneColor` maps a spec `Tone` to a `ToneToken`. Never hardcode a tinted `rgba`.
- Controls: `ui/Button` (`tone` tints the primary fill or a secondary/ghost label), `ui/TextField` (bordered input, hairline steps darker on focus), `ui/SegmentedTabs`, `ui/Collapse` (chevron header that shows/hides its content), `ui/ChecklistRow` (checkable row) on `ui/CheckMark` (the static done/not-done box).
- Cards: `ui/Card` (raised floating panel; the ask and habit gate cards), `ui/OptionRow` (selectable choice with description and right badge), `ui/TimerReadout` (large m:ss countdown over a `ProgressBar`). Photos: `lib/photo.ts` `choosePhoto` (camera or library, scaled JPEG ready to send).
- Content: `ui/DataTable` (hairline rows, muted header, content-sized columns that fill or scroll sideways, tabular right-aligned figures), `ui/ProgressBar`, `ui/Callout` (tone fill, tone hairline, tone icon), `ui/BlockQuote` (left bar; markdown blockquotes use it too), `ui/ListItem` (marker column + content; markdown lists use it too), `ui/TimelineItem` (dot on a hairline rail, right-aligned time), `ui/Avatar` (round photo, initials fallback), `agents/CodeBlock.tsx` (Prism highlighting, copy).
- Replies: `agents/WidgetActions.tsx`. The agent screen wraps the transcript in `SessionWidgetActions`; `useWidgetActions()` returns `{ reply(text) }` (an `agent.reply` with `submit: true` to that session) or null outside a session, where reply buttons and inputs render disabled.
- Existing: `ui/Pill`, `ui/IconButton` (`tone="overlay"` for white-on-glass controls over media), `ui/Text`, `ui/Row`, `ui/Sheet`.

A widget file should read as layout: primitives wired to its spec, with no styling or gesture
logic that another widget could need.
