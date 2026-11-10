// Council room prompts: one system prompt per role (Roles table of the spec, must-nots included)
// and one prompt per phase turn, plus the parsers for what the judge and the integrator answer.
// Spec: Eva work/relay-rooms-council/SPEC.md.
import {
  COUNCIL_IMAGES_PER_ROUND,
  COUNCIL_MODELS,
  COUNCIL_HARNESS_LABEL,
  COUNCIL_PARTS_4,
  COUNCIL_ROLE_LABEL,
  COUNCIL_TARGET_SCORE,
  type CouncilRole,
} from '@relay/protocol'
import type { RoomAgent, RoomSeat, RubricCriterion } from '@evaos/contract'
import { REPLY_MAX, dedash, trimReply } from '../prompts'

/** What a council seat's job is each round (spec, Roles). */
export const ROLE_JOB: Record<CouncilRole, string> = {
  integrator:
    "You write and own the contract (contract.md); you merge the builders' branches into main, run the contract checks (seams, names, palette, one shared shader), render the full figure and bounce a failing part back to its builder with the failure.",
  builder:
    'You write the procedural code for your part, expose its values as params in parts/<part>/params.json, render your part and fix the findings tagged to your part.',
  look: "You tune your part's params.json and shader values against the paintover and the references by eye, render the part and post the param diff.",
  director:
    'You set the look target: paintovers and concept images per part, look notes and part-tagged findings against the full render and the references.',
  critic:
    'You post numbered findings tagged by part, each with a severity (blocker, major or minor) tied to the reference, and confirm the ones that got fixed.',
  researcher:
    'You find sources, techniques and render tooling, and answer when a seat asks or a finding is marked unknown.',
  judge:
    'You score the full render against the rubric (0 to 10 per criterion), pick between competing branches when asked, and decide continue or converged.',
}

/** What a role must never do (spec, Roles; the council's no-scope-growth rule for critics). */
export const ROLE_MUST_NOT: Record<CouncilRole, string> = {
  integrator: "Never build a part, and never change a part's code without its builder.",
  builder: 'Never touch another part, and never edit contract.md (ask the integrator).',
  look: 'Never edit code; ask your builder when you need a new param.',
  director: 'Never propose new scope: judge against the brief and the references only.',
  critic: 'Never propose new scope: judge against the brief and the references only.',
  researcher: 'Never edit the deliverable.',
  judge: 'Never suggest fixes and never edit anything; you only score and decide.',
}

export const GUARD_NOTE =
  "Outward actions need Isaac's yes and are turned into a button in the room: git push, opening PRs, deploys, publishing, sending mail or messages, purchases, and deleting or writing anything outside the room workdir. Do the work locally; never try to get around the guard."

const FEED_RULES = `Feed rules:
- Do the real work with your tools; your reply is a short post in the room feed: 2 to 5 sentences or a short list, never more than ${REPLY_MAX} characters.
- Address people by first name; @FirstName asks someone directly.
- Messages are shown to you as \`[m12] Name: text\`. Never prefix your reply with your name or an id.
- Never use em dashes or en dashes; use commas or periods.
- Isaac asked for this; when he posts, his message comes first.`

export interface SeatContext {
  agent: RoomAgent
  seat: RoomSeat
  agents: readonly RoomAgent[]
  prompt: string
  /** The seat's working tree (main/ for the integrator). */
  tree: string
  workdir: string
  mainDir: string
  contractPath: string
  renderCmd: string
  parts: readonly string[]
  refs: readonly string[]
}

/**
 * The render command as a prompt shows it: the room's command (plus `--part` for one part), or
 * the one contract.md names when the room was started without one.
 */
export function renderCommand(cmd: string, part?: string): string {
  if (cmd === '')
    return part
      ? `the part render command contract.md names (for ${part})`
      : 'the render command contract.md names'
  return part ? `\`${cmd} --part "${part}"\`` : `\`${cmd}\``
}

const seatLine = (a: RoomAgent): string => {
  const s = a.seat
  if (!s) return `- ${a.name}`
  const part = s.part ? `, ${s.part}${s.branch ? ` (branch ${s.branch})` : ''}` : ''
  return `- ${a.name}: ${COUNCIL_ROLE_LABEL[s.role]}${part} (${COUNCIL_MODELS[s.modelKey].name} in ${COUNCIL_HARNESS_LABEL[s.harness]})`
}

/** The system prompt a council seat starts with. */
export function seatSystemPrompt(c: SeatContext): string {
  const role = c.seat.role
  const part = c.seat.part
    ? ` Your part: ${c.seat.part}${c.seat.branch ? `, branch ${c.seat.branch} (another builder builds the same part; the judge keeps one after round 2)` : ''}.`
    : ''
  const others = c.agents
    .filter((a) => a.id !== c.agent.id)
    .map(seatLine)
    .join('\n')
  return `You are ${c.agent.name}, the ${COUNCIL_ROLE_LABEL[role]} in a Relay council room that builds one deliverable together.${part}

Your job: ${ROLE_JOB[role]}
Must not: ${ROLE_MUST_NOT[role]}

The brief from Isaac:
${c.prompt}

Where things are:
- Your working tree: ${c.tree}${role === 'integrator' ? ' (this is main/, the integrated tree only you write)' : ' (your own git worktree; the room commits it after each of your turns)'}
- Room workdir: ${c.workdir}; integrated tree: ${c.mainDir}
- Contract: ${c.contractPath} (only the integrator edits it)
- Render command: ${renderCommand(c.renderCmd)} for the whole figure, ${renderCommand(c.renderCmd, '<name>')} for one part. Renders go under renders/ in your tree.
- References (read-only): ${c.refs.length > 0 ? c.refs.join(', ') : 'none'}
- Parts: ${c.parts.join(', ')}

The room:
${others}

${GUARD_NOTE}

${FEED_RULES}`
}

export function rubricPrompt(parts: readonly string[], refs: readonly string[]): string {
  const owners = [...new Set([...COUNCIL_PARTS_4, ...parts.filter((p) => p !== 'Whole')])]
  return `Draft the rubric you will score this room against: 4 to 7 criteria read from the references (${refs.length > 0 ? refs.join(', ') : 'the brief'}), each owned by one of: ${[...owners, 'Integrator', 'Look'].join(', ')}.
Answer with JSON only, one array on one line: [{"name":"face: horns, tattoo, eyes","owner":"Head"}]`
}

export function contractPrompt(o: {
  version: number
  parts: readonly string[]
  assignments: string
  contractPath: string
  bounceNote?: string
}): string {
  const again =
    o.version > 1
      ? ` This is contract v${o.version}: the room now splits into ${o.parts.length} parts, so re-split the code and update the contract.`
      : ''
  return `Contract phase.${again} Split the deliverable into these parts: ${o.parts.join(', ')}.
Assignments:
${o.assignments}
1. Write ${o.contractPath}: scale and origin, the seams every part must end on, naming, palette hex values, the one shared shader, params files (parts/<part>/params.json: builders own the code, look seats own the values) and the render command per part.
2. Cut the source into parts/<part>/... behind the contract so each builder edits only its own folder, and make every path relative to the tree (never write to the original source).
3. Render the full figure once so everyone starts from the same picture.
Then post a 2 to 4 sentence summary of the contract.`
}

export function paintoverPrompt(parts: readonly string[]): string {
  return `Contract phase. Generate ONE paintover image (the room's image for this phase) over the current render and the references that sets the look target for every part (${parts.join(', ')}). Save it under renders/ in your tree, then post the look notes per part in a short list.`
}

export const objectPrompt = (contract: string): string =>
  `The integrator posted the contract:\n${contract.slice(0, 3000)}\n\nObject in one line if something in it will not work for your role, or reply AGREE.`

export const planPrompt = (): string =>
  'Plan step. In 2 to 4 sentences: what you will do this run for your role, and what you need from the others.'

export function buildPrompt(o: {
  part: string
  round: number
  renderCmd: string
  split: boolean
  fixes: readonly string[]
  bounce?: string
  branchNote?: string
}): string {
  const render = renderCommand(o.renderCmd, o.split ? o.part : undefined)
  const fixes =
    o.fixes.length > 0
      ? `\nFindings and fixes routed to ${o.part}:\n${o.fixes.map((f) => `- ${f}`).join('\n')}`
      : ''
  const bounce = o.bounce ? `\nThe integrator bounced your part last round: ${o.bounce}` : ''
  return `Round ${o.round}, build. Work on ${o.part} only, in your tree.${o.branchNote ? ` ${o.branchNote}` : ''}${bounce}${fixes}
Edit the code and params for your part, then render it with ${render}. Post what you changed in 2 to 4 sentences.`
}

export function lookPrompt(o: {
  part: string
  round: number
  renderCmd: string
  fixes: readonly string[]
}): string {
  const fixes =
    o.fixes.length > 0
      ? `\nFindings routed to ${o.part}:\n${o.fixes.map((f) => `- ${f}`).join('\n')}`
      : ''
  return `Round ${o.round}, look. Tune ${o.part}'s params.json and shader values against the paintover and the references (attached), then render it with ${renderCommand(o.renderCmd, o.part)}.${fixes}
Post the param diff in a short list.`
}

export function integratePrompt(o: {
  round: number
  branches: { branch: string; who: string; part: string }[]
  renderCmd: string
  contractPath: string
}): string {
  return `Round ${o.round}, integrate. In main/, merge these branches:
${o.branches.map((b) => `- ${b.branch} (${b.who}, ${b.part})`).join('\n')}
Run the contract checks from ${o.contractPath} on each part, then render the full figure with ${renderCommand(o.renderCmd)} (renders under renders/).
A part that fails a check stays out of main: merge the rest and add one line per failing part, exactly \`BOUNCE <part>: <what failed>\`. Then post a 2 to 4 sentence note.`
}

export function critiquePrompt(o: {
  round: number
  parts: readonly string[]
  director: boolean
}): string {
  const image = o.director
    ? ` You may generate at most ${COUNCIL_IMAGES_PER_ROUND} image this round (a paintover for the part that drifted most); save it under renders/.`
    : ''
  return `Round ${o.round}, critique. Judge the full render (attached, with the references) against the brief and the references only.${image}
Post numbered findings, each tagged with its part and a severity, exactly like \`1. [Head] major: horns read too short against the target\`. Parts: ${o.parts.join(', ')}. Write \`unknown\` in a finding when nobody in the room knows how to fix it yet. Confirm findings from last round that are now fixed.`
}

export const researchPrompt = (questions: readonly string[]): string =>
  `Research. Answer these with sources, techniques or a tooling script (do not edit the deliverable):\n${questions.map((q) => `- ${q}`).join('\n')}\nPost the answer in a short list with links or paths.`

export function scorePrompt(o: {
  round: number
  rubric: readonly RubricCriterion[]
  parts: readonly string[]
  branched: readonly string[]
  retry?: boolean
}): string {
  const branches =
    o.branched.length > 0
      ? `\nAlso pick one branch per competing part on that part's criteria (A and B renders are attached): add "branches": {${o.branched.map((p) => `"${p}":"A"|"B"`).join(',')}}.`
      : ''
  const again = o.retry ? 'Your last answer was not valid JSON. ' : ''
  return `${again}Round ${o.round}, score. Score the full render (attached, with the references) against each criterion, 0 to 10. Target: every criterion at ${COUNCIL_TARGET_SCORE} or more. Criteria (id, name, owner):
${o.rubric.map((c) => `- ${c.id}: ${c.name} [${c.owner}]`).join('\n')}${branches}
Route the top fixes to parts (${o.parts.join(', ')}, Integrator or Look), stating what is wrong, never how to fix it.
Answer with JSON only, on one line: {"scores":{"<id>":{"score":7,"note":"short"}},"verdict":"continue"|"converged","note":"one sentence","fixes":[{"part":"Head","text":"what is still off"}]}`
}

export const finalPrompt = (): string =>
  'The room is delivering. State your final position in one line: start with AGREE or DISSENT, then why.'

export const answerPrompt = (): string =>
  'Isaac posted (see above). Answer him directly in 2 to 4 sentences; do any quick check with your tools first.'

/** A reply as it goes in the feed: house style and the length cap. */
export const feedText = (raw: string): string => trimReply(dedash(raw.trim()))

const jsonIn = (raw: string, open: '{' | '['): unknown => {
  const close = open === '{' ? '}' : ']'
  const start = raw.indexOf(open)
  const end = raw.lastIndexOf(close)
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The judge's drafted rubric: 4 to 7 criteria with known owners, ids c1..cN; null otherwise. */
export function parseRubric(raw: string, owners: readonly string[]): RubricCriterion[] | null {
  const v = jsonIn(raw, '[')
  if (!Array.isArray(v)) return null
  const out: RubricCriterion[] = []
  for (const item of v) {
    if (!isObj(item) || typeof item.name !== 'string' || typeof item.owner !== 'string') continue
    const owner = owners.find((o) => o.toLowerCase() === String(item.owner).trim().toLowerCase())
    if (!owner || item.name.trim() === '') continue
    out.push({ id: `c${out.length + 1}`, name: dedash(item.name.trim()), owner })
  }
  return out.length >= 4 ? out.slice(0, 7) : null
}

export interface ParsedScorecard {
  scores: Record<string, { score: number; note: string }>
  verdict: 'continue' | 'converged'
  note: string
  fixes: { part: string; text: string }[]
  branches: Record<string, 'A' | 'B'>
}

/** The judge's scorecard; null unless every criterion has a 0..10 score. */
export function parseScorecard(
  raw: string,
  rubric: readonly RubricCriterion[],
  branched: readonly string[],
): ParsedScorecard | null {
  const v = jsonIn(raw, '{')
  if (!isObj(v) || !isObj(v.scores)) return null
  const scores: ParsedScorecard['scores'] = {}
  for (const c of rubric) {
    const s = v.scores[c.id]
    const n = isObj(s) ? Number(s.score) : Number(s)
    if (!Number.isFinite(n)) return null
    scores[c.id] = {
      score: Math.max(0, Math.min(10, n)),
      note: isObj(s) && typeof s.note === 'string' ? dedash(s.note) : '',
    }
  }
  const fixes = Array.isArray(v.fixes)
    ? v.fixes
        .filter(isObj)
        .filter((f) => typeof f.part === 'string' && typeof f.text === 'string')
        .map((f) => ({ part: String(f.part), text: dedash(String(f.text)) }))
    : []
  const branches: ParsedScorecard['branches'] = {}
  if (isObj(v.branches)) {
    for (const p of branched) {
      const b = v.branches[p]
      if (b === 'A' || b === 'B') branches[p] = b
    }
  }
  return {
    scores,
    verdict: v.verdict === 'converged' ? 'converged' : 'continue',
    note: typeof v.note === 'string' ? dedash(v.note) : '',
    fixes,
    branches,
  }
}

export interface Finding {
  part: string
  severity: 'blocker' | 'major' | 'minor'
  text: string
  unknown: boolean
}

const FINDING_RE = /^\s*\d+[.)]\s*\[([^\]]+)\]\s*(blocker|major|minor)?\s*:?\s*(.+)$/i

/** Numbered, part-tagged findings from a critique; lines that do not match are skipped. */
export function parseFindings(raw: string, parts: readonly string[]): Finding[] {
  const out: Finding[] = []
  for (const line of raw.split('\n')) {
    const m = FINDING_RE.exec(line)
    if (!m) continue
    const tag = m[1]!.trim().toLowerCase()
    const part =
      [...parts, 'Integrator', 'Look'].find((p) => p.toLowerCase() === tag) ?? m[1]!.trim()
    const sev = (m[2]?.toLowerCase() ?? 'minor') as Finding['severity']
    const text = m[3]!.trim()
    out.push({ part, severity: sev, text, unknown: /\bunknown\b/i.test(text) })
  }
  return out
}

/** `BOUNCE <part>: <why>` lines of the integrator's reply, by known part. */
export function parseBounces(raw: string, parts: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const m = /^\s*BOUNCE\s+(.+?)\s*:\s*(.+)$/i.exec(line)
    if (!m) continue
    const part = parts.find((p) => p.toLowerCase() === m[1]!.toLowerCase())
    if (part) out[part] = m[2]!.trim()
  }
  return out
}

/** A final-position line: DISSENT (or a reservation) is dissent; everything else agrees. */
export const isDissent = (line: string): boolean => /^\W*dissent/i.test(line.trim())

/** Bounce lines are for the room, not the feed. */
export const withoutBounces = (raw: string): string =>
  raw
    .split('\n')
    .filter((l) => !/^\s*BOUNCE\s/i.test(l))
    .join('\n')
