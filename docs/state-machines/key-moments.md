# Key moments of a live call (host)

The key moments of one live recording on the host (`apps/linux/src/meetings/key-moments.machine.ts`, driven by `key-moments.ts` from `MeetingsService`): decisions, asks of Isaac, actions and notable claims, found by Claude Haiku a window of transcript at a time and kept in the recording's `moments.json`. It ends `done` once the call has ended and the last lines were looked at; its output is the moments, which the after-call notes list under `## Key Moments`.

- `idle`: every final line so far has been looked at; the next one opens a window.
- `gathering`: a window is open for 45 s from its first line, collecting the lines said meanwhile.
- `extracting`: the window's lines go to the model with the lines just before them as context and the moments found so far, so none is found twice. Lines said meanwhile wait for the next window.
- `backoff`: the model failed; it is asked again after 10 s, then 20 s. After the third failure those lines are let go.
- `ending`: the call ended; whatever is still waiting (or was being looked at) gets one last extraction, with the same retries, before `done`.
- A line the call later names (a voice gets its person) renames the moments said on it, in any state.

<!-- diagram:start (generated from the machine by `pnpm machines:docs`; do not edit) -->
```mermaid
stateDiagram-v2
  state "any state" as anyState
  [*] --> live
  state live {
    [*] --> live_idle
    state "idle" as live_idle
    state "gathering" as live_gathering
    state "extracting" as live_extracting
    state "backoff" as live_backoff
  }
  state ending {
    [*] --> ending_checking
    state "checking" as ending_checking
    state "extracting" as ending_extracting
    state "backoff" as ending_backoff
  }
  live --> ending : call.ended
  live_idle --> live_gathering : transcript.lines [hasLines]
  live_gathering --> live_extracting : after window
  live_extracting --> live_gathering : done extract [hasPending]
  live_extracting --> live_idle : done extract
  live_extracting --> live_backoff : error extract [canRetry]
  live_extracting --> live_gathering : error extract [hasPending]
  live_extracting --> live_idle : error extract
  live_backoff --> live_extracting : after retry
  ending_checking --> done : always [nothingInFlight]
  ending_checking --> ending_extracting : always
  ending_extracting --> done : done extract
  ending_extracting --> ending_backoff : error extract [canRetry]
  ending_extracting --> done : error extract
  ending_backoff --> ending_extracting : after retry
  done --> [*]
```
<!-- diagram:end -->
