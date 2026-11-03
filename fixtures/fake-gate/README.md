# fake-gate

Stateful, dependency-free stand-in for `.omp/tools/habit-gate.ts`. Selected with `EVAOS_HABIT_GATE_BIN`.

## Env

| Var | Meaning |
|-----|---------|
| `FAKE_GATE_STATE` | state file (default `<tmpdir>/evaos-fake-gate/state.json`); seeded on first use |
| `FAKE_GATE_SCENARIO` | `unlocked` (default) or `locked` seed |
| `FAKE_GATE_MINUTE_MS` | length of one habit minute in ms (default 60000); use 10 for fast timers |
| `FAKE_GATE_PHOTOS` | photo dir (default `<state dir>/photos`); a 1x1 `walk-proof.png` is written here |
| `FAKE_LOG` | append `{t, tool, argv, cwd}` JSON lines |
| `<state>.fail` | when this file exists every command fails with "simulated failure" |

## Commands

`status`, `start <id>`, `done <id> [--photo <path>]`, `override <reason...>`, `habit add <name...> --minutes N [--photo]`, `habit edit <id> --name X --minutes N (--photo | --no-photo)`, `habit rm <id>`, `task add <name...> [--minutes N]`, `task rm <id>`.

Any argument starting with `--` is a flag, like the real CLI. Success prints the full status JSON and exits 0. With `--json`, failures print `{"error": "..."}` and exit 1.

Seed: habits stretch (10 min) and walk (20 min, photo), task taxes (30 min), a calendar plan with one done and one upcoming break, three history rows.

`fixtures/fake-job-run/fake-job-run.mjs <name>` is the matching job-run fake: it logs argv and cwd, and writes a lock, a run folder and `last-run` under `jobs/.runs` only when `FAKE_JOB_RUN_WRITE=1` (duration `FAKE_JOB_MS`, default 1500).
