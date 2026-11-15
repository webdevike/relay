# Isaac's design rules (cite a finding's rule by its id)

Distilled from the isaac-design skill and the design lines of Isaac's voice notes. His rules win over generic advice.

## His hard rules (breaking one is at least major)
- `hierarchy`: the highest-intent thing (what the user looks at or acts on first) is the loudest, by size AND weight AND color; secondary and tertiary content is dimmed as much as the primary is emphasized. A wall of equal-weight content is a defect.
- `spacing-grouping`: spacing encodes grouping. Related elements sit tight; more space around a group than inside it. A title and its description are one unit: near-zero gap, then a larger gap before the rest. Never ambiguous spacing.
- `remove-it`: every element (icon, label, border, badge, count chip, line of copy) earns its place; if it can be removed, remove it. Adornments are noise until proven otherwise.
- `caps-eyebrow`: no all-caps or mono kicker/eyebrow stacked above a heading. One clear heading; context goes in sentence-case subtext below.
- `border-or-shadow`: a surface gets a border OR a subtle shadow, never both; prefer the border. Only floating overlays (menu, popover, modal, hover card) and borderless chips keep a shadow.
- `vibe-coded`: banned generic AI look: a colored left (or top) accent stripe on a card, floating rounded white cards with drop shadows stacked in a list. Do instead: flat rows with hairline dividers, or one bordered table; status in a quiet pill or the value itself.
- `quiet-hover`: hovers are a subtle border-color shift; no lift, no color-flipping accent.
- `icons`: Tabler icons; never glyph arrows or checks typed as text (arrows, check marks).
- `em-dash`: no em dashes anywhere in UI copy.
- `copy`: plain, direct, specific copy; say what a thing is.
- `table-alignment`: first column left-aligned, other columns centered, numeric columns right-aligned.

## Heuristics (Refactoring UI, with his overrides)
- `action-hierarchy`: one primary action (solid), secondary actions outlined or subtle, tertiary as links. A destructive action is quiet until its confirmation step.
- `consistency`: sizes, spacing, radius and type come from one scale; no hand-tuned one-offs; same component, same padding and row height; do not mix square and round corners.
- `typography`: two weights at most, never under 400; two or three text colors (dark, grey, lighter grey); body line length 45 to 75 characters; taller line-height for small text, near 1 for big headings; left-align body, center only short blocks.
- `contrast`: body text at least 4.5:1, large text 3:1; no grey text on a colored background (use a same-hue tint); never color alone as the signal.
- `data-drives-form`: the data shapes the element: finite sets as chips, numbers right-aligned, long text truncated with a tooltip, inactive items dimmed, time data as a timeline or chart, color only where it means something.
- `labels`: labels are a last resort; fold the label into the value ("12 left"); a needed label is secondary.
- `fewer-borders`: separate with a background shift, spacing or one hairline, not stacked borders or boxes inside boxes.
- `whitespace`: generous space by default, density only on purpose (tables, dashboards); content does not have to fill the width.
- `disclosure`: frequent actions visible, rare ones in a menu or popover near their trigger; every icon-only control has a tooltip; designed empty, loading and error states.
- `app-shell`: (Relay, eCard and mockups use Mantine) sidebar on the window background, main view as an inset bordered card, an optional right panel as a second inset card.

## Measured rules (a layout tool can confirm these on a live page)
- `overlap`: text or boxes cover each other.
- `clipped-text`: text cut off, spilling out of its box, or a short label truncated with an ellipsis.
- `page-overflow`: the page scrolls sideways or content is cut at the viewport edge.
- `touch-target`: a control smaller than 24px and crowded, or under 44px on a phone.
- `alignment`: an item sitting off the edge or row its siblings share; side-by-side cards with mismatched tops or row heights; uneven gaps in a repeated set.
- `tiny-text`: text under 11px on phones (10px elsewhere), or line-height outside 1.2 to 2.0 for wrapped body text.

## Scoring
- 10: nothing to fix. 8 to 9: polish only. 6 to 7: a few major issues. 4 to 5: broken hierarchy or a banned pattern. 3 or less: content or function lost (overlap, clipped content, unusable).
- Severity: `blocking` = content or function lost, or a banned pattern; `major` = hurts hierarchy, grouping or scanning; `minor` = polish.
