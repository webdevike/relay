import { describe, expect, it } from 'vitest'
import { parseComputer } from './command'
import { routeTask, type ComputerAssistant } from './route'

describe('parseComputer', () => {
  it('takes only a message that starts with @computer', () => {
    expect(parseComputer('please @computer open Calculator')).toBeNull()
    expect(parseComputer('@computers are neat')).toBeNull()
    expect(parseComputer('@computer-use is a skill')).toBeNull()
    expect(parseComputer('  @Computer open Calculator')).toEqual({
      kind: 'run',
      mode: 'headless',
      task: 'open Calculator',
    })
  })

  it('reads the mode keyword only as the first word', () => {
    expect(parseComputer('@computer live open TextEdit')).toEqual({
      kind: 'run',
      mode: 'live',
      task: 'open TextEdit',
    })
    expect(parseComputer('@computer liven up the doc')).toEqual({
      kind: 'run',
      mode: 'headless',
      task: 'liven up the doc',
    })
    expect(parseComputer('@computer open walk.txt')).toEqual({
      kind: 'run',
      mode: 'headless',
      task: 'open walk.txt',
    })
  })

  it('`background` is headless outright, so a task that starts with "live" stays one', () => {
    expect(parseComputer('@computer background live demo prep')).toEqual({
      kind: 'run',
      mode: 'headless',
      task: 'live demo prep',
    })
  })

  it('keeps the subject of "walk me through"', () => {
    expect(parseComputer('@computer walk me through ENG-6810')).toEqual({
      kind: 'run',
      mode: 'walk',
      task: 'ENG-6810',
    })
    expect(parseComputer('@computer walk through adding 2 and 2 in Calculator')).toEqual({
      kind: 'run',
      mode: 'walk',
      task: 'adding 2 and 2 in Calculator',
    })
  })

  it('answers help for a bare command or a mode with no task, and reads controls', () => {
    expect(parseComputer('@computer')).toEqual({ kind: 'help' })
    expect(parseComputer('@computer walk')).toEqual({ kind: 'help' })
    expect(parseComputer('@computer stop')).toEqual({ kind: 'control', op: 'stop' })
    expect(parseComputer('@computer Next')).toEqual({ kind: 'control', op: 'next' })
    expect(parseComputer('@computer stop the timer in Clock')).toEqual({
      kind: 'run',
      mode: 'headless',
      task: 'stop the timer in Clock',
    })
  })
})

describe('routeTask', () => {
  const agents: ComputerAssistant[] = [
    { id: 'astra', title: 'Astra', profile: 'work' },
    { id: 'nova', title: 'Nova', profile: 'personal' },
    { id: 'polaris', title: 'Polaris', profile: 'personal' },
  ]

  it('a name in the task wins over eCard and the thread, and is removed', () => {
    const r = routeTask('Nova, walk me through ENG-6810', agents, 'astra', [])
    expect(r.assistant.id).toBe('nova')
    expect(r.task).toBe('walk me through ENG-6810')
  })

  it('eCard work goes to Astra: issue keys, PRs, ecard, repo names', () => {
    expect(routeTask('ENG-6810', agents, null, []).assistant.id).toBe('astra')
    expect(routeTask('open the PR list', agents, 'nova', []).assistant.id).toBe('astra')
    expect(
      routeTask('check node-storefront-service builds', agents, null, ['node-storefront-service'])
        .reason,
    ).toBe('repo:node-storefront-service')
    expect(
      routeTask('check my-node-storefront-service-x', agents, null, ['node-storefront-service'])
        .assistant.id,
    ).toBe('nova')
  })

  it('otherwise the thread the chat is, else Nova', () => {
    expect(routeTask('what is 12 times 7', agents, 'polaris', []).assistant.id).toBe('polaris')
    expect(routeTask('what is 12 times 7', agents, null, []).assistant.id).toBe('nova')
  })
})
