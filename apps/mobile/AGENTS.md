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
- Media: `ui/ImageFrame.tsx`, `ui/MediaPlaceholder.tsx` (host-not-connected states), `ui/ImageCaption.tsx`, `ui/OverlayTag.tsx` (corner labels/badges on media), `agents/ZoomableImage.tsx` (pinch/pan/double-tap), `agents/ImageViewer.tsx` (full-screen pager).
- Existing: `ui/Pill`, `ui/IconButton` (`tone="overlay"` for white-on-glass controls over media), `ui/Text`, `ui/Row`, `ui/Button`, `ui/Sheet`.

A widget file should read as layout: primitives wired to its spec, with no styling or gesture
logic that another widget could need.
