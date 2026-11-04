import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { REPO_ROOT } from './helpers/paths'

// Agent access end to end, the way an omp session uses it: relay-mcp (Eva's .omp/tools/relay-mcp.ts,
// stdio MCP) against a hidden test instance. The agent describes the screen, switches the theme
// (Isaac sees "Nova changed theme to Ocean · Undo", and both Undo paths put it back), builds a deep
// link to Settings > Connections, opens it, and points at a control. EVAOS_PROOF=1 keeps the
// transcript and screenshots in proof/agent-access/.
const MCP = process.env.RELAY_MCP ?? path.join(os.homedir(), 'Eva/.omp/tools/relay-mcp.ts')
const PROOF = path.join(REPO_ROOT, 'proof', 'agent-access')

const test = base.extend({ launchEnv: { EVAOS_AGENT_CONTROL: '1' } })

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string }>
  isError?: boolean
}

/** A stdio MCP client that keeps a readable transcript of every call. */
class McpClient {
  private next = 1
  private buf = ''
  private waiting = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>()
  readonly transcript: string[] = []

  constructor(private proc: ChildProcessWithoutNullStreams) {
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.buf += chunk
      let nl: number
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl)
        this.buf = this.buf.slice(nl + 1)
        const msg = JSON.parse(line) as { id: number; result?: unknown; error?: unknown }
        this.waiting.get(msg.id)?.(msg)
        this.waiting.delete(msg.id)
      }
    })
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.next++
    const answered = Promise.withResolvers<{ result?: unknown; error?: unknown }>()
    this.waiting.set(id, answered.resolve)
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return answered.promise.then((msg) => {
      if (msg.error) throw new Error(JSON.stringify(msg.error))
      return msg.result
    })
  }

  /** tools/call, logged as `> tool {args}` then its answer (images as their size). */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const r = (await this.request('tools/call', { name, arguments: args })) as ToolResult
    const shown = r.content
      .map((c) =>
        c.type === 'image' ? `[image/png ${Buffer.from(c.data!, 'base64').length} bytes]` : c.text,
      )
      .join('\n')
    this.transcript.push(
      `> ${name} ${JSON.stringify(args)}`,
      `< ${r.isError ? 'ERROR ' : ''}${shown!.length > 1600 ? `${shown!.slice(0, 1600)}\n  ...` : shown}`,
      '',
    )
    return r
  }

  json(r: ToolResult): Record<string, unknown> {
    expect(r.isError, r.content[0]?.text).toBeUndefined()
    return JSON.parse(r.content[0]!.text!) as Record<string, unknown>
  }

  close(): void {
    this.proc.stdin.end()
    this.proc.kill()
  }
}

async function shot(mcp: McpClient, out: string, name: string): Promise<void> {
  const r = await mcp.call('window_screenshot', { path: path.join(out, `${name}.png`) })
  expect(r.content[0]).toMatchObject({ type: 'image' })
}

const toast = (shell: Page) => shell.getByTestId('agent-change-toast')

test('an agent tours and configures Relay through relay-mcp', async ({
  shell,
  configDir,
}, info) => {
  test.skip(!fs.existsSync(MCP), `relay-mcp not found at ${MCP}`)
  const out = process.env.EVAOS_PROOF === '1' ? PROOF : info.outputPath('agent-access')
  fs.mkdirSync(out, { recursive: true })
  const controlFile = path.join(configDir, 'agent-control.json')
  await expect.poll(() => fs.existsSync(controlFile), { timeout: 15_000 }).toBe(true)

  const mcp = new McpClient(
    spawn('bun', [MCP], {
      env: {
        ...process.env,
        RELAY_CTL_FILE: controlFile,
        RELAY_ASSISTANT: 'nova',
        RELAY_MCP_CACHE: path.join(configDir, 'mcp-catalog.json'),
      },
      stdio: 'pipe',
    }),
  )
  try {
    const init = (await mcp.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agent-access.spec', version: '1' },
    })) as { serverInfo: { name: string } }
    expect(init.serverInfo.name).toBe('relay-mcp')
    const { tools } = (await mcp.request('tools/list')) as { tools: Array<{ name: string }> }
    const names = tools.map((t) => t.name)
    for (const t of [
      'describe',
      'pages_list',
      'settings_get',
      'settings_set',
      'settings_undo',
      'connections_list',
      'connections_add',
      'link',
      'link_open',
      'tour_highlight',
    ]) {
      expect(names).toContain(t)
    }
    mcp.transcript.push(`tools/list: ${names.length} tools (${names.join(', ')})`, '')

    // 1. What is on screen.
    const seen = mcp.json(await mcp.call('describe'))
    expect(String(seen.text)).toMatch(/^Page: /)
    expect(String(seen.text)).toContain('Theme: Default, light')

    // 2. Switch the theme: Isaac sees who did it with Undo.
    expect(mcp.json(await mcp.call('settings_get', { key: 'theme.preset' }))).toMatchObject({
      settings: [{ key: 'theme.preset', value: 'default' }],
    })
    const ocean = mcp.json(await mcp.call('settings_set', { key: 'theme.preset', value: 'Ocean' }))
    expect(ocean).toMatchObject({ value: 'ocean', previous: 'default', changed: true })
    await expect(toast(shell).filter({ hasText: 'theme to Ocean' })).toHaveText(
      'Nova changed theme to Ocean·Undo',
    )
    await shot(mcp, out, '1-theme-ocean-toast')

    const dark = mcp.json(await mcp.call('settings_set', { key: 'theme.mode', value: 'dark' }))
    expect(dark).toMatchObject({ value: 'dark', changed: true })
    const darkToast = toast(shell).filter({ hasText: 'appearance' })
    await expect(darkToast).toHaveText('Nova changed appearance to dark·Undo')
    await shot(mcp, out, '2-dark-toast')

    // Undo from the toast (Isaac), then from the agent (settings.undo).
    await darkToast.getByTestId('agent-change-undo').click()
    await expect
      .poll(async () => mcp.json(await mcp.call('settings_get', { key: 'theme.mode' })).settings)
      .toMatchObject([{ value: 'light' }])
    const undone = mcp.json(await mcp.call('settings_undo', {}))
    expect(undone).toMatchObject({ key: 'theme.preset', value: 'default' })
    expect(String(mcp.json(await mcp.call('describe')).text)).toContain('Theme: Default, light')
    expect(
      (await mcp.call('settings_set', { key: 'theme.colors.dark.body', value: 'blue' })).isError,
    ).toBe(true)

    // 3. A deep link to Settings > Connections, opened in the app.
    const link = mcp.json(await mcp.call('link', { connection: 'github' }))
    expect(link).toEqual({
      url: 'relay://open/settings/connections?connect=github',
      label: 'Settings › Connections › GitHub',
      markdown:
        '[Settings › Connections › GitHub](relay://open/settings/connections?connect=github)',
    })
    mcp.json(await mcp.call('link_open', { url: link.url }))
    await expect(shell.getByTestId('settings-connections')).toBeVisible()
    await expect(shell.getByTestId('connection-github')).toHaveAttribute('data-focused', 'true')
    await expect(shell.getByTestId('tour-spotlight')).toHaveAttribute(
      'data-target',
      'connection-github',
    )
    const there = mcp.json(await mcp.call('describe'))
    expect(there.page).toMatchObject({
      key: 'settings',
      section: 'Connections',
      link: 'relay://open/settings/connections',
    })
    await shot(mcp, out, '3-connections-deep-link')

    const conns = mcp.json(await mcp.call('connections_list'))
    expect((conns.connections as Array<{ id: string }>).map((c) => c.id)).toEqual([
      'relay-host',
      'github',
      'linear',
      'slack',
      'anthropic',
      'openai',
    ])
    expect(mcp.json(await mcp.call('connections_add', { id: 'github' }))).toMatchObject({
      status: 'needs-user',
      link: 'relay://open/settings/connections?connect=github',
    })

    // 4. A tour step: point at a control describe listed.
    const controls = (there.controls as Array<{ target: string }>).map((c) => c.target)
    expect(controls).toContain('nav-setting')
    const spot = mcp.json(
      await mcp.call('tour_highlight', {
        target: 'nav-setting',
        title: 'Theme',
        caption: 'Colors, fonts and light or dark live here. Ask me to change them any time.',
        step: { n: 2, of: 4 },
      }),
    )
    expect(spot).toMatchObject({ target: 'nav-setting' })
    await expect(shell.getByTestId('tour-caption')).toContainText('Step 2 of 4')
    await shot(mcp, out, '4-tour-highlight')
    mcp.json(await mcp.call('tour_clear'))
    await expect(shell.getByTestId('tour-spotlight')).toHaveCount(0)
  } finally {
    fs.writeFileSync(
      path.join(out, 'transcript.md'),
      `# relay-mcp smoke transcript\n\nHidden test instance (temp config), agent RELAY_ASSISTANT=nova.\n\n\`\`\`\n${mcp.transcript.join('\n')}\n\`\`\`\n`,
    )
    mcp.close()
  }
})
