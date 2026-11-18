# sound

Finds sounds in Isaac's Soundly account and stages them in a temporary collection ("Eva picks: <query>") he previews in the Soundly app, then removes those collections. Research and the API: `work/soundly-agent/RESEARCH.md` in Eva.

## Agents

| Agent id (job)                          | What it does                                                                                                                                                                                                                        | Input -> output event                                                                                                                                                                | Model     | Triggers                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | --------------------------------------- |
| `soundly-picks` (`pick`; code agent)    | Semantic search in Soundly, the model picks `count` varied sounds from up to 60 candidates (Pro sounds left out unless `includePro`), a new "Eva picks: <query>" collection gets them. Sweeps expired Eva picks in the same session | `sound.requested {query, count?, includePro?, requestId?}` -> `sound.collected {collection, sounds: [{title, library, duration, id, pro}], search, soundly, ...}`, `expired.removed` | haiku-5-5 | that event (the `asks` pair), manual    |
| `soundly-cleanup` (`sweep`; code agent) | Deletes Eva picks collections older than 24 h (`all`: every one), plus Eva picks the ledger does not know. Never any other collection                                                                                               | `{all?, olderThanHours?, scheduled?}` -> `collections.swept {removed, soundly?, deferred?}`                                                                                          | none      | cron `15 * * * *` (`scheduled`), manual |

## How a run treats Isaac's Soundly app

Soundly allows one signed-in session per account, so the API sign-in signs the desktop app out. Every run goes through `Soundly.session` (`adapters/soundly.ts`, machine `adapters/soundly/session.machine.ts`, doc `docs/state-machines/soundly-session.md` at the repo root):

1. **Idle gate**: while Soundly is the app in front and Isaac gave input in the last 2 minutes, it looks again every 15 s, up to 15 minutes (the hourly cleanup does not wait: it emits `deferred` and tries next hour). Then it fails without touching the app.
2. An open Soundly (hidden or not) is asked to quit with `NSRunningApplication.terminate` (JXA, no Apple Event; normal quit, tabs saved), waiting up to 15 s for it to exit; only if it stays, its Soundly > Quit Soundly menu item is pressed over accessibility by cua-driver (needs the main window reachable), waiting up to 30 s more. Never force-killed: a Soundly still running after that fails the run with the app untouched.
3. One API sign-in with the login the app saved, then the work.
4. However the work ended, an app that was open is relaunched with `open -g` (never activated; `EVA_AGENT=1` for the focus guard), plus `-j` unless Soundly was the app in front when the run quit it. Soundly shows itself once its window exists, so a relaunch that was not in front is then hidden through `NSRunningApplication.hide()` (JXA, no Apple Event), and the app that was in front is activated again only if Soundly took the focus from it and the hide did not return it. Isaac's "Restore tabs" choice (`ShowRestoreTabsPromptOnStartup1;<account email>`: absent or 0 asks in a modal) is set to 1 for that launch when it would ask, and put back afterwards.
5. It reads the app every 2 s for up to 2 minutes, answering a Restore tabs prompt (Yes) if one shows anyway, until the log has `Tab groups: cloud answered` after the relaunch and the Soundly window has no Sign In button. The reply's `soundly` says `{wasOpen, signedInAgain, verifiedBy, problem?}`; a run that left the app signed out fails after its reply.

A Soundly that was closed stays closed. One session at a time across processes (`<home>/state/sound/soundly.lock`).

## Pro sounds

Isaac's account is on the Free plan, so by default only sounds included without Soundly Pro are collected (`includePro: true` lifts that). Soundly marks them per search hit: the row's `IsForFreeAccount` is `1` for a sound a Free account has; the desktop app shows every other hit to a Free account as Pro-only (`fileListTree.insertSearchResults`), and the agent treats a row without the flag the same way (`Match.pro`). The search call has no Pro filter, so the agent fetches the most hits Soundly returns (500), filters client-side and keeps the best `candidateCount` open ones; a search whose hits are all Pro fails saying so.

## Adapters and state

- `adapters/soundly/api.ts`: the private cloud API (Login, HybridSearch with keyword fallback, GetPlaylists, NewPlaylist, AddFilesToPlaylist, GetPlaylist, DeletePlaylist, and `download(fileId)`: a Search on the file id, then the signed URL of its original WAV from the hit's `UrlList`; Pro sounds are refused on the Free plan, and the signed URL carries the session id so it is never logged). Constants come from the installed app through `app_constants.py` under its own interpreter (cached per build). The saved login and the session id stay in memory; never logged or written.
- `adapters/soundly/desktop.ts`: the app side (probe via `lsappinfo` and `ioreg` HIDIdleTime, quit and accessibility via `cua-driver call`, relaunch via `open`).
- `adapters/ledger.ts`: `<home>/state/sound/collections.json` (what Eva made, for the 24 h TTL) and `searches.json` (the last 40 searches with Soundly's candidates, the bench cases). A collection is deleted only when its live name starts with `Eva picks: ` and the account owns it (`Admin`).

## Run, bench, test

From `packages/atomic-agents`:

```
bun src/cli.ts run soundly-picks pick --input '{"query":"heavy wooden door slam in a large hall","count":6}'
bun src/cli.ts run soundly-cleanup sweep --input '{"all":true}'
bun domains/sound/bench/soundly-picks.ts [--models a,b]
bun test domains/sound
```

`bench/soundly-picks.ts` replays the recorded searches through the model step only (no sign-in, the app is never touched): usable replies, exact count, varied sets, mean Soundly rank, p50 s, $/case; answers to `<home>/bench/soundly-picks/results-<stamp>.json`. Do not use `cli.ts bench` on this agent: it runs the whole job per model, one sign-in each. Tests use a fake app and account (`test/sound.test.ts`); `test/machine-docs.test.ts` keeps the machine's doc in sync.

## Gotchas

- Needs Soundly installed and signed in once with Remember me, and cua-driver's daemon with Accessibility (`cua-driver permissions status`). Without cua-driver the app cannot be quit, so an open Soundly makes the run fail untouched; the sign-in check then falls back to the log alone.
- Each run with Soundly open costs Isaac ~15 to 30 s of a closed app and stops any playback.
- Undocumented API: a server change breaks it loudly (no UI fallback).
