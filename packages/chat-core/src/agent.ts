/** Who a chat belongs to, in tab order (native chat.rs Agent::ALL). */
export const CHAT_AGENTS = ['Eva', 'Eren', 'Elysia', 'Jobs'] as const
export type ChatAgentName = (typeof CHAT_AGENTS)[number]

/** How much of a session file `classifyHead` reads (native CLASSIFY_BYTES). */
export const CLASSIFY_BYTES = 32 * 1024

/** The agent whose persona line a first prompt opens with (native agent_for_prompt). */
export function agentForPrompt(text: string): ChatAgentName {
  if (text.startsWith('You are Eren,')) return 'Eren'
  if (text.startsWith('You are Elysia,')) return 'Elysia'
  if (text.startsWith('You are executing Eva job')) return 'Jobs'
  return 'Eva'
}

const TEXT_KEYS = ['"text":"', '"content":"']

/**
 * The agent of one raw JSONL line when it is the first user message, else null (native classify,
 * which reads the raw line: the earliest `"text":"` or `"content":"` string starts the prompt).
 */
export function agentOfLine(line: string): ChatAgentName | null {
  if (!line.includes('"type":"message"') || !line.includes('"role":"user"')) return null
  let start = -1
  for (const key of TEXT_KEYS) {
    const at = line.indexOf(key)
    if (at >= 0 && (start < 0 || at + key.length < start)) start = at + key.length
  }
  return agentForPrompt(start < 0 ? '' : line.slice(start))
}

/** The agent a session's start shows: its first user prompt's persona line, else Eva. */
export function classifyHead(head: string): ChatAgentName {
  for (const line of head.split('\n')) {
    const agent = agentOfLine(line)
    if (agent !== null) return agent
  }
  return 'Eva'
}
