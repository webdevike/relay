# Reply chips eval

Offline check of the agent-emitted reply-chip rule: when an assistant reply ends on a question with a
few clear answers, the agent appends `[[replies: a | b]]` and Relay shows tap-to-reply chips. This eval
asks a model, primed with the rule, which line it would append to real Nova and Astra replies, then
scores the result against hand labels. Modeled on CopilotKit OpenDuet's `evals/reply-chips`
(deterministic label checks plus human-labelled gold), but on Relay's own transcripts.

## What it measures

1. **Show or not.** Confusion matrix of "chips shown" against the gold `should_show`: precision,
   recall, accuracy. "Shown" means the host's own `splitReplies`
   (`apps/linux/src/assistant/replies.ts`) left two or more chips, exactly what the phone would get.
2. **Format.** Of the markers a model emitted, the share whose raw labels already meet the spec
   (2 to 4, nonempty, at most 24 characters, distinct). "Dropped by parser" counts markers the parser
   cut below two chips (an over-long label is dropped), which silently shows nothing.
3. **Chip quality** on true positives, judged by `anthropic/claude-sonnet-5-5`: 0 to 2
   (2 = covers the likely answers and every tap is correct; 1 = usable but misses a main option or
   awkward wording; 0 = wrong or misleading), plus coverage = share of gold chips semantically matched
   by a predicted chip.
4. **Hand review** of the 5 worst rows per model (`hand-review-<date>.json`, or
   `hand-review-<date>-<variant>.json`, keyed `<model>:<id>` and rendered into the results).

Models: `anthropic/claude-opus-5-5` (what the assistants run) and `anthropic/claude-haiku-5-5` as a
cheap baseline, to see whether a host-side cheap-model fallback would be viable. Both run with
`--thinking off`, no tools, no session, no extensions, skills or rules, in an empty temp directory.

## Dataset

`dataset.jsonl`, 34 items from the Nova and Astra thread transcripts
(`~/.config/relay/assistants/{nova,astra}.json` -> `sessionFile` + `history[]`). The assistant text is
the last assistant message with text before Isaac's next message.

| Kind           | Gold | Nova | Astra | What it is                                                                              |
| -------------- | ---- | ---- | ----- | --------------------------------------------------------------------------------------- |
| `yes_no`       | show | 5    | 4     | Offers and confirmations ("Want me to ship it?", "Was that you?")                       |
| `choice`       | show | 4    | 7     | Either/or and named options (trims, A to D, who merges)                                 |
| `open`         | no   | 4    | 2     | Open questions, a clarification ending "or something else?", a multi-pick "Which ones?" |
| `voice`        | no   | 1    | 0     | A voice-call turn (the rule skips those)                                                |
| `not_to_isaac` | no   | 0    | 1     | Ends on a question inside a draft comment for someone else                              |
| `statement`    | no   | 3    | 3     | No closing question (one asks mid-message, then ends on a reminder)                     |

Each row: `id`, `agent`, `kind`, `session` + `line` (source transcript row), `isaac_before` (his
previous message, at most 400 characters), `assistant` (the reply as written), `isaac_next` (his actual
next message, at most 200 characters; evidence only), `should_show`, `gold` (2 to 4 chips in his voice,
naming the action on hard-to-undo yeses), `note`. Gold was hand-labelled from the rule's intent, using
`isaac_next` only as a hint. Emails, phone numbers, a street address and token-like strings are
redacted, and image drop paths are shortened to `/drops/<image>`; wording is otherwise unchanged. The
transcripts are Isaac's private threads, so keep this file to what the eval needs.

## Run

```sh
# from the repo root; needs `omp` signed in to Anthropic
bun evals/reply-chips/run.ts --date 2026-10-28                     # generate, judge, score
bun evals/reply-chips/run.ts --date 2026-10-28 --score-only        # rescore from the cache
bun evals/reply-chips/run.ts --models haiku --concurrency 4        # one model, today's date
bun evals/reply-chips/run.ts --date 2026-10-28 --variant proposed  # the reworded rule in run.ts
```

Raw model and judge outputs (with tokens and omp's list-price cost) go to `outputs-<date>.jsonl`;
rerunning only calls models for missing rows, so delete that file for a fresh sample. Results go to
`results-<date>.md`. A `--variant` other than `spec` writes `outputs-<date>-<variant>.jsonl` and
`results-<date>-<variant>.md`. All prompts (the rule, the generator and the judge) live in `run.ts`;
`RULE` must stay a verbatim copy of the spec's Rules section.

## Cost

One full run is 68 generation calls and up to 40 judge calls of about 850 input tokens each, about two
minutes at concurrency 4. At list price (omp's estimate) the 2026-10-28 run came to about $0.24 for
Opus, under $0.01 for Haiku, and about $0.16 for the Sonnet judge.

## Caveats

One sample per item at 34 items: a one-row difference is 3 points, so Opus and Haiku are within noise
of each other on show accuracy. The `proposed` variant was written after reading the failures on this
same dataset, so its numbers are optimistic; confirm on fresh transcripts before adopting it.
