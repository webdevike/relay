import { describe, expect, it } from 'vitest'
import { agentForPrompt, agentOfLine, classifyHead } from './agent'

const prompt = (content: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'message', id: 'u', message: { role: 'user', content, ...extra } })

describe('agentForPrompt', () => {
  it('names the agent whose persona line the prompt opens with, else Eva', () => {
    expect(agentForPrompt("You are Eren, Eva's housekeeping assistant")).toBe('Eren')
    expect(agentForPrompt("You are Elysia, Isaac's background synthesis")).toBe('Elysia')
    expect(agentForPrompt('You are executing Eva job `inbox-sweep`')).toBe('Jobs')
    expect(agentForPrompt('Fix the Relay pairing')).toBe('Eva')
    // Only the opening counts.
    expect(agentForPrompt('Hi. You are Eren, right?')).toBe('Eva')
    expect(agentForPrompt('You are Astra, a personal assistant')).toBe('Eva')
  })
})

describe('classifyHead', () => {
  it('reads the first user message of the head, text parts or plain content', () => {
    const head = [
      JSON.stringify({ type: 'session', id: 's', cwd: '/e' }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'You are Eren,' } }),
      prompt([{ type: 'text', text: "You are Elysia, Isaac's" }]),
      prompt('You are Eren, later'),
    ].join('\n')
    expect(classifyHead(head)).toBe('Elysia')
    expect(classifyHead(prompt('You are executing Eva job x'))).toBe('Jobs')
  })

  it('is Eva without a user message, and a non-user line is not a prompt', () => {
    expect(classifyHead(JSON.stringify({ type: 'session', id: 's' }))).toBe('Eva')
    expect(agentOfLine(JSON.stringify({ type: 'custom', role: 'user' }))).toBeNull()
    expect(agentOfLine(prompt([{ type: 'image', data: 'x' }]))).toBe('Eva')
  })
})
