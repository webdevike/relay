# gmail

Read-only triage of Isaac's new personal Gmail into needs_isaac, fyi or noise, each with a one-line reason and a card title.

## Agents

One agent, `gmail.json` (id `gmail`), one job.

| Job      | Input                                      | Output events                                          | Default model                                | Triggers                      |
| -------- | ------------------------------------------ | ------------------------------------------------------ | -------------------------------------------- | ----------------------------- |
| `triage` | `{ ids?: string[] }` (Message-IDs; replay) | `message.triaged` per message, then `triage.completed` | `anthropic/claude-haiku-5-5`, thinking `off` | `manual`, cron `*/30 * * * *` |

- Flow: source `gmail.new_since_cursor` -> prompt `{{message}}` -> model (tools `gmail.read_thread`, `gmail.sender_history`, `maxSteps` 3) -> `message.triaged`; run summary -> `triage.completed`.
- `message.triaged`: `id`, `from`, `subject`, `date`, `verdict` (needs_isaac | fyi | noise), `reason`, `title`.
- `triage.completed`: `messages`, `modelCalls`, `cost`, `replay`.
- Candidate models: `anthropic/claude-haiku-5-5`, `openai-codex/gpt-6-luna`, `anthropic/claude-sonnet-5-5`.
- Knowledge files injected into the system prompt, both under `${EVA_ROOT:-~/Eva}/work/eva/agents/nova/`: `catchup-taste.md` and `catchup-rules.json`.

## Tools and adapters

- `adapters/pack.ts`: `gmailPack`. Defines the `Gmail` service (wraps `mail.py`), the source `gmail.new_since_cursor`, and the tools `gmail.read_thread` (conversation size and last messages) and `gmail.sender_history` (counts of mail from and to an address, stars, recent subjects). The source returns inbound mail after the cursor, oldest first, at most 40 per run (`MAX_PER_RUN`).
- Cursor: `<state dir>/cursor.json` (`{validity, uid}`), written atomically after each message's event is written. No cursor or a new UIDVALIDITY starts from the last 24 hours. With `ids` the cursor is untouched.
- `adapters/mail.py`: Python 3 IMAP client with subcommands `new`, `ids`, `thread`, `sender`. It loads the heartbeat's login helper `jobs/eva-heartbeat/scripts/gmail.py`, which reads `secrets/gmail.env`, all under `EVA_ROOT` (default `~/Eva`). It uses `EXAMINE` on `[Gmail]/All Mail` and `BODY.PEEK`, so it cannot mark, label, archive, send or delete. On failure it prints `{"error": ...}` and exits 2.

## Run, bench, test

From `packages/atomic-agents`:

```
bun src/cli.ts run gmail triage --input '{}'
bun src/cli.ts run gmail triage --input '{"ids": ["<Message-ID>"]}'
bun src/cli.ts bench gmail triage --input '{"ids": ["<Message-ID>"]}' --models anthropic/claude-haiku-5-5,anthropic/claude-sonnet-5-5
bun domains/gmail/bench/gmail-score.ts --reference <run> <run>...
bun test domains/gmail
```

- `gmail-score.ts` reads bench run events and prints per run: verdict counts, agreement with Isaac's answer key, agreement with the reference run, calls, cost, plus the disagreements with the reference. The key comes from `work/eva/agents/nova/catchup-notes.jsonl` under `EVA_ROOT` (entries with `source: "gmail"`, `cardId: "gmail:<Message-ID>"`).
- `test/gmail.test.ts` covers the tool loop (maxSteps, allowlist, bad JSON feedback) and the triage cursor using a fake `Gmail` layer and scripted models, so it needs no network or credentials. Not run here: dependencies were not installed in this worktree.

## Exports via index.ts

- `gmailPack`: the adapter pack (source and two tools) registered in `src/packs.ts`.

## Gotchas

- Real runs need the heartbeat's `secrets/gmail.env` and `jobs/eva-heartbeat/scripts/gmail.py` under `EVA_ROOT`; the knowledge files and the bench answer key also live under `EVA_ROOT`.
- The cursor advances per message after its event is written, so a failed message stops the cursor there and is retried next run. Batches over 40 messages continue on the next run.
- Replay with `ids` never moves the cursor, so use it for benches and reruns.
- Mail is read from All Mail excluding sent, drafts and chats (`-in:sent -in:drafts -in:chats`); Spam and Trash are not included.
- Message bodies are cut to 1500 characters; thread excerpts to 8 messages of 1200 characters.
- `read_thread` and `sender_history` return `{error}` for an unknown id or address instead of failing the run.
