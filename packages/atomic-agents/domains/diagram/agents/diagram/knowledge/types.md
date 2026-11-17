# Types: layout grammar per kind

Each type owns its axis, shapes and connector grammar. Load the one you chose and hold it; never mix two grammars in one diagram.

## Flowchart (kind `flow`)

Best for decision logic, processes with branches, routing, triage.

- Shape carries type, not color: start and end are pills (`rx=20`), steps are rectangles (`rx=6`), decisions are diamonds (at most 3 exits), a merge point is a filled `dot` `r=4`.
- Flow runs top to bottom (or left to right when the process is long and shallow). From a diamond: yes down or right, no to the side; label every exit (`YES`, `NO`, or the condition in 14 characters).
- Accent the happy path or the single most consequential decision, never every decision.
- Process without decisions (a pipeline): a left-to-right row of steps, optional zones per stage, data handoffs as labeled connectors.
- Budget: 9 nodes, 12 connectors. Anti-patterns: fill color for node type, 4-exit diamonds, unlabeled branches.

## Loop (kind `loop`)

Best for reinforcing cycles, flywheels, game loops, operating loops: work advances clockwise around a ring while each pass writes into one shared center that accumulates state. Use Flowchart if the path does not truly return to its first step.

Inputs: one hub (name plus short sublabel: the accumulated state, never a step) and 5 to 8 stations, clockwise from the top. At most one focal station. Station `160 x 64`, hub `200 x 104`, ring radius `R = 240` (260 for 7 or 8 stations), canvas `1040` wide.

Geometry (y grows downward), hub center `C = (cx, cy)`, N stations, station `k` from 0:

```text
theta_k = -90deg + k * 360deg / N
station center P_k = (cx + R cos theta_k, cy + R sin theta_k), box = center -/+ (80, 32), rounded to the 4px grid symmetrically
```

Ring connectors are arcs on the same circle, clockwise: from where the circle leaves station k's box to just before it enters station k+1's box, `M ax ay A R R 0 0 1 bx by`, class `c`, `marker-end="url(#arrow)"`. Find the exit and entry points by intersecting the circle with the box edges: for a vertical edge `x = xe`, `y = cy +/- sqrt(R^2 - (xe - cx)^2)` within the edge; for a horizontal edge `y = ye`, `x = cx +/- sqrt(R^2 - (ye - cy)^2)` within the edge. Pull the end point back along the circle by about 1.2px (angle `1.2 / R`) so the arrowhead tip lands on the box edge. Large-arc flag 0, sweep flag 1 always. The last station returns to the first with the same formula. Keep three decimals on arc end points.

Write-back spokes are straight radial lines from the station's inner edge toward the hub, class `c-soft`, `marker-end="url(#arrow-soft)"`, stopping 6px before the hub edge. With unit vector `u` from C toward P_k: start = `P_k - min(80/|ux|, 32/|uy|) * u`, end = `C + (min(100/|ux|, 52/|uy|) + 6) * u` (skip a term whose denominator is zero). Spokes are the one place a slanted straight line is allowed. Label at most 2 or 3 spokes, beside the line on a mask.

Draw order: paper, ring arcs, spokes, spoke labels, stations, hub, text. The hub is the only `n-hub` element (filled with ink, text in paper). Never route a connector through the hub. Things outside the cycle (win and lose conditions, an external force) go outside the ring: a `n-risk` box or an annotation callout in a corner, with a dashed connector if it needs one; they do not count as stations.

Canonical 6-station placement: `viewBox 0 0 1040 760` with the header band, `C = (520, 420)`, `R = 240`; stations at centers (520,180), (728,300), (728,540), (520,660), (312,540), (312,300).

Anti-patterns: two hubs, solid spokes, uneven angles, mixing arcs with elbows in the ring, accent on several stations, more than 8 stations, a "cycle" that never returns.

## Sequence (kind `sequence`)

Best for request and response flows, protocols, multi-actor interactions over time.

- Actors are boxes in a row at the top (at most 5), each with a dashed lifeline down (`stroke-dasharray 3 3`, rule color).
- Messages are horizontal arrows between lifelines, time flowing down, at least 24px apart. Never an upward arrow.
- Kinds: call is solid `c` (or `c-link` for external); return is dashed `c-dash` with a filled arrowhead; fire-and-forget is dashed with an open arrowhead; the one headline success may be `c-accent`.
- Activation bar: `8` wide rect on the lifeline while the actor holds control.
- Branches use one combined fragment frame (`ALT`, `OPT` or `LOOP` tab in mono at its top-left, guard `[condition]` under it, a dashed divider between the 2 `alt` regions), spanning only the lifelines involved. At most one fragment, no nesting.
- Labels sit above their message line on a mask, never over another lifeline.
- Budget: 5 lifelines, 12 messages.

## Architecture (kind `architecture`)

Best for system overviews, integration maps, how parts of a product or game connect.

- Group by tier, trust boundary or subsystem with up to 3 zones. Primary flow runs left to right or top to bottom; pick one and hold it.
- Treatments carry kind: `n-step` services or systems, `n-store` data and resources, `n-external` outside actors, `n-input` the user or player, `n-focal` the 1 or 2 nodes the reader must notice.
- Elbow connectors with `r=8`. When a destination is clearly above or below, enter through its top or bottom edge with a single-bend path. Bridge the less important connector at a crossing.
- Budget: 9 nodes, 12 connectors, 3 zones. Anti-patterns: every box accented, bidirectional arrows where one direction is obvious, legend inside the diagram.

## State machine (kind `state`)

Best for finite states (order status, auth, connection, unit or building state) and lifecycles.

- States are rounded rectangles `rx=8` with `name-lg` names; start is a filled dot `r=6`, end a ringed dot.
- Transitions are labeled `EVENT [GUARD] / ACTION` in mono (drop parts not needed). Forward transitions are straight or elbowed along the dominant direction; a return transition may be one smooth curve above or below the row, dashed; a self-loop is a small curve above the state.
- Accent the state the reader must notice (the failure state or the happy completion).
- Lifecycle phase map variant: one subject through 4 or 5 phases on a left-to-right rail, a separate lower band for waits or recovery, a separate band for terminal outcomes (failure and cancellation as distinct boxes). Budget 9 states, 10 transitions.
- Anti-patterns: transitions from every state to the same error (one note `* -> Error on timeout` instead), unlabeled transitions, more than twice as many transitions as states.

## Timeline (kind `timeline`)

Best for milestones, histories, roadmaps, incident timelines.

- A hairline baseline across the middle; ticks at time boundaries with mono date labels below.
- Events are filled dots `r=4` on the baseline; labels alternate above and below on 1px drops so they never collide. Major milestones: accent dot `r=6` with a `name` label.
- Spacing is honest: unequal intervals are spaced unequally; break the axis visibly if a stretch is empty.
- Phases or eras: thin bands above the baseline, labeled in mono.

## Tree (structure)

- Root at top, children below (or root at left). Parent drops a short vertical, a horizontal bus spans the siblings, each child drops into its top edge. Never diagonal.
- Nodes `120` to `180` wide, `40` to `52` tall, two widths at most. Depth 4 at most, 5 children per level at most.
- Accent the root or one critical leaf, not both.

## Layer stack (structure)

- 4 to 6 full-width horizontal bands of equal height (`56` to `72`), same x and width.
- Each band: index tag at the far left in mono, the layer name in `name-lg` at left of center, a short note in `sub` at the right.
- A direction note in the left margin (`abstraction`, `requests`). Accent one band at most.
