# fake omp

Deterministic stand-in for `omp --mode rpc-ui` (D-23). Selected with `EVAOS_OMP_BIN` (default in dev and tests).
Tests must never attach to a real omp session.

## Flags and env

- `--mode rpc-ui` (the chat transport), `--resume <file>` (echoed as `sessionFile`, never opened for writing in rpc-ui mode), `--session-dir` ignored. Launch switches `--approval-mode`, `--profile`, `--model`, `--thinking` are accepted and only appear in the `spawn` log argv. Any other mode exits 2.
- `--mode rpc` is the short-lived helper mode (rename and model catalog). With `--resume f`, `set_session_name {id, name}` rewrites the `title` record of `f` and answers success (the one case where the fake writes the resume file; e2e points it only at tmp copies from `makeChatFixture`). With `--no-session`, `get_available_models` answers `data.models` (4 entries: two dated aliases of one image-capable reasoning model, one text-only model, one with `contextWindow: null`). Exits 0 when stdin closes.
- `[--profile <name>] usage --json` (no `--mode`; the usage meter): prints `usage/<name>.json` (scrubbed real `omp usage --json` captures, emails and ids replaced) with `generatedAt`, every `fetchedAt` and `resetsAt` moved by the same offset so `generatedAt` is now. `FAKE_OMP_USAGE_DIR` replaces the `usage/` folder (e2e rewrites it to test refresh); a missing file exits 1 with one stderr line, a file that is not JSON is printed as is. Never logged.
- `FAKE_OMP_SESSIONS_DIR`: a chat started without `--resume` reports a planned `<ISO with - for : and .>_<uuid>.jsonl` path in this dir as `get_state.data.sessionFile` (null when unset) and creates it (session header plus the user message) on the first prompt.
- `FAKE_OMP_CHUNK`: `line` (default) | `1` (byte per write) | `glued` (whole replay in one write) | `emoji-split` (split inside the first multibyte char of each line) | `burst` (no delay) | `slow` (150 ms per frame).
- `FAKE_OMP_DELAY_MS` per-frame delay (default 15). `FAKE_OMP_RECORDING`: `turn` (default) | `long-turn` (~400 message_update frames).
- `FAKE_OMP_LOG=<path>`: JSON lines `{ t, event: spawn|stdin-line|stdin-end|signal|exit|set-model, detail }` (`set-model` carries `{provider, modelId}`).
- `FAKE_OMP_STDERR=1`: one stderr line per prompt.

## Behaviour

`ready` first (protocol v1, `supportedProtocolVersions: [1,2]`; the app never negotiates v2). Commands: `set_ask_dialog`, `get_state` (adds `contextUsage {tokens: 42000, contextWindow}`, `model`, `thinkingLevel`, `fastModeEnabled`), `prompt`, `abort`, `set_subagent_subscription`, `set_model {provider, modelId}`, `set_thinking_level {level}`, `set_fast_mode {enabled}`, `set_session_name {name}` (the last four update `get_state`), `extension_ui_response`. A prompt during a replay is queued (`queue_update`), then echoed and answered after the turn. Closing stdin exits 0 after 200 ms.

## Prompt keywords (anywhere in the message)

- `[select]` (5 options with optionDetails), `[confirm]`, `[input]`, `[editor]`, `[ask]` (one question, 4 options, recommended 1), `[ask-multi]` (two questions, second `multi: true`), `[ask-bad]` (`questions` is a string): emit `agent_start`, then `extension_ui_request {id:'ui-<n>', method, ...}` and wait. `extension_ui_response` with that id continues the turn with the reply `Answer received: <compact JSON of the response minus type/id>`, or `Answer received: cancelled` for `{cancelled:true}`. Every response is logged `{event:'ui-response', detail:<frame>}`. Closing stdin cancels waiting dialogs and exits 0 within 1 s.
- `[slow]`: 400 ms per frame for the reply, so writer and abort tests can race it.
- `prompt.images`: logged `{event:'prompt-images', detail:{count, mimeTypes}}`; reply `Got <n> image(s)`.
- A Relay room member (`--system-prompt` starting `You are <Name>, a member of a Relay room`): every prompt is answered `<Name> here, turn <n>. I read the room and agree.` in 7 deltas, `FAKE_OMP_SEAT_DELAY_MS` (default 120) per frame, logged `{event:'seat-turn', detail:{name, turn}}`.

## Recordings

Recorded from real omp 18.8.5 (`node scripts/record-omp.mjs <raw>`, throwaway temp cwd and `--session-dir`, haiku, no tools), scrubbed by `node scripts/scrub-recording.mjs <raw>`. Each line is `{ "dt": ms, "frame": {...} }`.
`turn.jsonl` = `agent_start` .. `session_settled` of turn 1; `abort-tail.jsonl` = frames from the aborted assistant `message_end` to `session_settled`; `long-turn.jsonl` is synthesised from `turn.jsonl`.

Observed handshake (real omp 18.8.5): `ready {protocolVersion:1, supportedProtocolVersions:[1,2], maxFrameBytes:1048576, maxReassembledFrameBytes:67108864}` about 235 ms after spawn, then unsolicited `extension_ui_request(setWidget)`, `advisor_cost_changed`, `available_commands_update`; responses to `set_ask_dialog` then `get_state`; `prompt` ack; about 4 s to `agent_start`. Abort tail order: `message_end(aborted)`, `turn_end`, `agent_end`, `response(abort)`, `prompt_result(aborted)`, `session_settled`. Closing stdin: exit code 0.
