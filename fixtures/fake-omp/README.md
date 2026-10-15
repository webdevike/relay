# fake omp

Deterministic stand-in for `omp --mode rpc-ui` (D-23). Selected with `EVAOS_OMP_BIN` (default in dev and tests).
Tests must never attach to a real omp session.

## Flags and env

- `--mode rpc-ui` (required), `--resume <file>` (echoed as `sessionFile`, never opened for writing), `--session-dir` ignored.
- `FAKE_OMP_CHUNK`: `line` (default) | `1` (byte per write) | `glued` (whole replay in one write) | `emoji-split` (split inside the first multibyte char of each line) | `burst` (no delay) | `slow` (150 ms per frame).
- `FAKE_OMP_DELAY_MS` per-frame delay (default 15). `FAKE_OMP_RECORDING`: `turn` (default) | `long-turn` (~400 message_update frames).
- `FAKE_OMP_LOG=<path>`: JSON lines `{ t, event: spawn|stdin-line|stdin-end|signal|exit, detail }`.
- `FAKE_OMP_STDERR=1`: one stderr line per prompt.

## Behaviour

`ready` first (protocol v1, `supportedProtocolVersions: [1,2]`; the app never negotiates v2). Commands: `set_ask_dialog`, `get_state`, `prompt`, `abort`, `set_subagent_subscription`, `extension_ui_response` (ignored). A prompt during a replay is queued (`queue_update`), then echoed and answered after the turn. Closing stdin exits 0 after 200 ms.

## Recordings

Recorded from real omp 18.8.5 (`node scripts/record-omp.mjs <raw>`, throwaway temp cwd and `--session-dir`, haiku, no tools), scrubbed by `node scripts/scrub-recording.mjs <raw>`. Each line is `{ "dt": ms, "frame": {...} }`.
`turn.jsonl` = `agent_start` .. `session_settled` of turn 1; `abort-tail.jsonl` = frames from the aborted assistant `message_end` to `session_settled`; `long-turn.jsonl` is synthesised from `turn.jsonl`.

Observed handshake (real omp 18.8.5): `ready {protocolVersion:1, supportedProtocolVersions:[1,2], maxFrameBytes:1048576, maxReassembledFrameBytes:67108864}` about 235 ms after spawn, then unsolicited `extension_ui_request(setWidget)`, `advisor_cost_changed`, `available_commands_update`; responses to `set_ask_dialog` then `get_state`; `prompt` ack; about 4 s to `agent_start`. Abort tail order: `message_end(aborted)`, `turn_end`, `agent_end`, `response(abort)`, `prompt_result(aborted)`, `session_settled`. Closing stdin: exit code 0.
