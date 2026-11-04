// A new assistant's first run. `admin.ts` scaffolds its prime.md with `onboardingPrime`: the
// prime (its session's first message) runs a short setup interview, one voice-friendly question
// per message, then has the assistant write its own prime.md from the home's
// `.omp/templates/assistant-prime.md` and save its registry entry through the host
// (`relay-linux assistant set`). The look and voice questions are widgets the host draws:
// `avatarChoices` and `voiceChoices` turn rendered drops into OpenUI programs whose buttons send
// the pick as the user's next turn ("Avatar 3", "Voice: marin").

/** Where the setup interview, and later the assistant's own instructions, live under the agent home. */
export const PRIME_TEMPLATE_FILE = ".omp/templates/assistant-prime.md";

/** Optional desktop controls (RelayAgentAccess, branch eva/agent-access): theme, connections, deep links. */
export const RELAY_CTL_FILE = ".omp/tools/relay-ctl.ts";

/** GPT-Live voices a live call can speak in (the registry's `liveVoice`). */
export const LIVE_VOICES = ["marin", "cedar", "coral", "sage", "ash", "verse", "alloy", "ballad", "echo", "shimmer"] as const;

/** pocket-tts catalog voices a local call can speak in (the registry's `voice`). */
export const LOCAL_VOICES = ["alba", "marius", "javert", "jean", "fantine", "cosette", "eponine", "azelma"] as const;

/** What a voice sample says; one phrase for every voice, so each is rendered once and cached. */
export const SAMPLE_TEXT = "Hi, this is how I would sound when we talk on a call.";

/** Avatar faces offered per page. */
export const AVATARS_PER_PAGE = 6;

export interface OnboardingContext {
  readonly id: string;
  readonly title: string;
  /** What the person asked for when they created it; empty when they gave nothing. */
  readonly scope: string;
  /** Who the assistant works for (host.json `human`). */
  readonly userName: string;
  /** The host CLI, e.g. `bun "/Users/x/Eva/work/relay/apps/linux/src/main.ts"` or the app's binary. */
  readonly cli: string;
  /** The assistant's thread memory, relative to the agent home. */
  readonly threadFile: string;
  /** The other assistants, `Title (id): scope`, one per line item. */
  readonly others: readonly string[];
  /** How a hand-off is sent, with `<id>` and `<text>` to fill (Eva's eva-thread.ts, else the host CLI). */
  readonly handoff: string;
}

/**
 * The first line every assistant prime starts with, the stub and the filled template alike: the
 * host hides a thread's first message when it starts with the current prime's first line, so a
 * thread primed with the stub stays hidden after the assistant rewrites its prime.
 */
export function primeFirstLine(title: string, userName: string): string {
  return `You are ${title}, ${userName}'s assistant, in your one continuous thread with them. This session is that thread: it stays open on ${userName}'s Mac, and they read and answer it from Relay on the iPhone and on the desktop. Treat it like a messaging conversation with a person, not a coding session.`;
}

/** The stub prime.md of a brand-new assistant: the setup interview, then writing its own prime. */
export function onboardingPrime(c: OnboardingContext): string {
  const user = c.userName;
  const others = c.others.length === 0 ? "none yet" : c.others.join("; ");
  const asked = c.scope.trim() === "" ? "" : ` ${user} described you as: "${c.scope.trim()}".`;
  return `${primeFirstLine(c.title, user)}

You were just created and are not set up yet.${asked} Your first job is a short setup interview; then you write your own instructions. Your id is \`${c.id}\`.

How to run the setup:
- Reply to this message right away with a one-line hello and question 1. If ${user}'s first message is only a greeting, carry on with the interview. If it is a real request, help with it briefly, then offer to finish setting up.
- One question per message, one or two short sentences, plain spoken words: no headings, lists, tables, code or em dashes. Any message may be read aloud on a call (a turn starting \`[Voice call\`), so it must make sense heard.
- When the answer comes from a small set, end with a line \`[[replies: <answer> | <answer>]]\` holding two to four short tap answers in ${user}'s words.
- "Skip" or "you pick" means take a sensible default and move on. Never ask the same thing twice. Keep notes of the answers as you go.

The questions, in order:
1. Purpose: what should you mainly help with?
2. Owns: what is yours to just handle (kinds of tasks, accounts, apps, places)?
3. Never touches: what should you stay out of, or never do?
4. Tone: how should you sound? [[replies: Short and direct | Warm and chatty | Calm and formal]]
5. Hand-offs: when something is not yours, who should get it? The other assistants today: ${others}. Skip this when there are none.
6. Look: run \`${c.cli} assistant avatars --agent ${c.id}\` and send one short sentence asking ${user} to tap a face, followed by the command's output exactly as printed (an \`\`\`openui block). A tap arrives as "Avatar <n>". "Show me more avatars" means run it again with \`--page 2\` (then 3, ...).
7. Voice: run \`${c.cli} assistant voices --agent ${c.id}\` and send its output the same way. A tap arrives as "Voice: <name>" (a GPT-Live voice) or "Local voice: <name>" (a pocket-tts voice). If the command says there are no voices, skip this question.
8. Model: suggest one model in one sentence from what they told you: a fast, cheaper one for quick lookups and chat, a strong one for planning, writing and code. Run \`omp models\` if you need the names. Offer [[replies: <the one you suggest> | You pick | Skip]]. "Skip" leaves the model unset (the account's default).
9. Extras: only if \`${RELAY_CTL_FILE}\` exists, ask once whether they want to change Relay's theme or add a connection now; if yes, run \`bun ${RELAY_CTL_FILE} --help\` and use its settings.set and connections actions. When the file is missing, skip this silently.

When you have the answers, in this order:
1. Write your instructions to \`.omp/assistant/agents/${c.id}/prime.md\`, replacing this whole setup text, from \`${PRIME_TEMPLATE_FILE}\`: fill every {{placeholder}} (assistantName ${c.title}, assistantId ${c.id}, userName ${user}, relayCli \`${c.cli}\`, threadFile \`${c.threadFile}\`, and the interview answers) and keep its first line exactly as filled in, starting "You are ${c.title}, ${user}'s assistant". Hand-off lines use \`${c.handoff}\`. If the template is missing, write the same first line and these sections: Identity, Scope (what you own), Never touches, Reply style, Voice calls, Hand-offs, Approvals, Changing yourself.
2. Save your registry entry: \`${c.cli} assistant set --agent ${c.id} --scope "<one line, at most 60 characters>" --avatar-choice <n> --live-voice <name>\` (use \`--voice <name>\` for a local voice, add \`--model <provider/id>\` when one was chosen). It prints what changed; on an error, fix the value and run it again.
3. If \`AGENTS.md\` has a \`## Your assistants\` list, add one line for yourself: \`- **${c.title}** (${c.id}): <scope>\`.
4. Put what you learned about ${user} in \`${c.threadFile}\` (create it from \`.omp/assistant/thread.template.md\` if it is missing).
5. Show a summary card and ask "Does this look right?" with [[replies: Looks good | Change something]]. On "Change something", ask what, change it (prime.md and/or \`assistant set\`), and show the card again. The card, filled in:

\`\`\`openui
root = Card([who, facts], "${c.title} is set up")
who = Avatar("${c.title}", "<scope>", "relay://assistant/${c.id}/avatar")
facts = Rows([Row("Owns", "<short>"), Row("Never touches", "<short>"), Row("Tone", "<short>"), Row("Hands off to", "<short>"), Row("Voice", "<name>"), Row("Model", "<model or default>")])
\`\`\`

From then on, follow your new prime.md for the rest of this thread.

Always, setup included:
- Anything outside this Mac or hard to undo (push, deploy, posting, email, purchases, deletes) needs ${user}'s explicit yes in this thread first.
- Never edit another assistant's prime.md or registry entry.
- Keep the session title \`${c.title}\`.`;
}

/** One avatar candidate as offered: its number in the grid and the drop it is drawn in. */
export interface AvatarChoice {
  readonly n: number;
  readonly path: string;
}

/** The look question's widget: a grid of faces, each with a button that sends "Avatar <n>". */
export function avatarChoices(title: string, choices: readonly AvatarChoice[]): string {
  const cells = choices.map((choice) => `a${String(choice.n)}`);
  const lines = [
    `root = Card([grid, more], "Pick a look for ${title}")`,
    `grid = Grid([${cells.join(", ")}], 3, "sm")`,
    ...choices.flatMap((choice) => {
      const n = String(choice.n);
      return [
        `a${n} = Stack([i${n}, b${n}], "vertical", "xs")`,
        `i${n} = Image("${choice.path}", "Avatar ${n}", null, null, 1)`,
        `b${n} = Button("Avatar ${n}", @ToAssistant("Avatar ${n}"))`,
      ];
    }),
    `more = Button("Show me more", @ToAssistant("Show me more avatars"), null, "subtle")`,
  ];
  return lines.join("\n");
}

/** One voice sample as offered: the voice, which engine speaks it, and the drop it plays from. */
export interface VoiceChoice {
  readonly voice: string;
  readonly engine: "live" | "local";
  readonly path: string;
}

/** The voice question's widget: a sample player per voice, each with a button that sends the pick. */
export function voiceChoices(title: string, choices: readonly VoiceChoice[]): string {
  const name = (voice: string) => voice.charAt(0).toUpperCase() + voice.slice(1);
  const cells = choices.map((_, index) => `v${String(index + 1)}`);
  const lines = [
    `root = Card([grid], "Pick a voice for ${title}")`,
    `grid = Grid([${cells.join(", ")}], 2, "sm")`,
    ...choices.flatMap((choice, index) => {
      const n = String(index + 1);
      const said = choice.engine === "live" ? `Voice: ${choice.voice}` : `Local voice: ${choice.voice}`;
      return [
        `v${n} = Stack([p${n}, b${n}], "vertical", "xs")`,
        `p${n} = Audio("${choice.path}", "${name(choice.voice)}")`,
        `b${n} = Button("Use ${name(choice.voice)}", @ToAssistant("${said}"))`,
      ];
    }),
  ];
  return lines.join("\n");
}
