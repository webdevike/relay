# fake-claude-bridge

Test stand-in for the Claude bridge (`.claude/bridge/session.ts`). Accepts `--rpc`, `--no-relay`, `--resume <file>`,
delegates to `../fake-omp/fake-omp.mjs --mode rpc-ui` and appends `{event:'claude-bridge', detail:{argv}}` to `FAKE_OMP_LOG`.
`--no-relay` also maps to rpc-ui because fake-omp implements no other mode.
Selected by `EVAOS_CLAUDE_BRIDGE_BIN` and `EVAOS_CLAUDE_BIN` (set by every e2e launch).
