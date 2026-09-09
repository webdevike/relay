# Input

`PointerModel` is pure logic; `CGEventPoster` is the only place that touches CoreGraphics.

**Acceleration**: `gain = clamp(1.2 + (4/3) * speed, 1.0, 3.5)`, `speed = |Δ| / dt` (pt/ms).
Sub-pixel remainder carries across calls so slow drags aren't lost to truncation.

**Scroll phase fields** (`CGEventField` integer values):

| `ScrollPhase` | scrollPhase | momentumPhase |
| --- | --- | --- |
| began / changed / ended | 1 / 2 / 4 | 0 |
| momentum (first / later) | 0 | 1 / 2 |
| momentumEnded | 0 | 3 |

**Why TCC needs a stable signature**: macOS keys the Accessibility grant to the app bundle's
code-signing identity, not to whoever launched it. An ad-hoc signature's identity is the binary's
cdhash, which changes on every rebuild, so the grant resets each time. Wave 2's bundling owns
signing `Relay.app` with a stable local identity so `AXIsProcessTrusted()` survives rebuilds
(see `apps/eva-clicky/build.sh` in the Eva hub for the pattern; not copied here).
