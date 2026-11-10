// The judge behind an open ask closing itself: did Isaac's later turns in the thread already answer
// the assistant's question, in his own words? A cheap model (`claude -p` on Haiku, no tools, no
// MCP, no settings, no saved session) reads the question, his turns after it and the assistant's
// reply to the latest, and says ANSWERED only when the question is clearly settled; anything else,
// an error included, leaves the ask open (the turn count still closes it in time).

import { tmpdir } from "node:os";
import { z } from "zod";
import type { ToolRun } from "../reviews/exec";
import type { AskCase } from "./ask-store";
import { clipAt } from "./asks";

const JUDGE_TIMEOUT_MS = 60_000;
/** Characters of each of his turns, and of the assistant's reply, the judge reads. */
const MAX_TURN_CHARS = 600;
const MAX_REPLY_CHARS = 400;

const ClaudeOut = z.object({ result: z.string(), is_error: z.boolean().optional() });

/** True when Isaac's turns clearly answered or settled the case's question. Rejects when the model could not be asked. */
export type AskJudge = (ask: AskCase) => Promise<boolean>;

export function judgePrompt(ask: AskCase): string {
  const turns = ask.said.map((said, i) => `${String(i + 1)}. ${clipAt(said, MAX_TURN_CHARS)}`).join("\n");
  return `An assistant asked its user a question in a chat. Decide whether the user's later messages already answer it.

Question the assistant asked:
${ask.question}

The user's messages after it, oldest first:
${turns}
${ask.reply === undefined ? "" : `\nThe assistant's reply to the latest of them:\n${clipAt(ask.reply, MAX_REPLY_CHARS)}\n`}
Say ANSWERED only when it is clear the question is settled: the user picked an option, said yes or no, gave the asked-for detail, declined, or told the assistant to do something that makes the question moot, or the assistant's reply plainly acts on such an answer. Say OPEN when the messages are about something else, only partly answer it, are ambiguous, or you are unsure.

Reply with exactly one word: ANSWERED or OPEN.`;
}

/** The model's verdict: ANSWERED alone counts; anything else is open. */
export function parseVerdict(text: string): boolean {
  return /^\W*answered\W*$/i.test(text.trim());
}

/** `claude -p` on Haiku with no tools, no MCP servers, no settings and no saved session. */
export function claudeAskJudge(run: ToolRun, claude: string): AskJudge {
  return async (ask) => {
    const res = await run(
      [claude, "-p", judgePrompt(ask), "--model", "haiku", "--tools", "", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", ""],
      { cwd: tmpdir(), timeoutMs: JUDGE_TIMEOUT_MS },
    );
    if (res.timedOut) throw new Error("Claude took too long");
    if (res.code !== 0) throw new Error(`claude exited ${res.code === null ? "by a signal" : String(res.code)}`);
    let json: unknown;
    try {
      json = JSON.parse(res.stdout);
    } catch {
      throw new Error("Claude returned no answer");
    }
    const out = ClaudeOut.safeParse(json);
    if (!out.success || out.data.is_error === true) throw new Error("Claude returned no answer");
    return parseVerdict(out.data.result);
  };
}
