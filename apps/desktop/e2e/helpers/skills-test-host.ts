// The Skills editor's comments and suggestions against the Relay host's own code: a throwaway host
// process (relay apps/linux/test/skills-test-host.ts: the real `/skills` routes and live rooms over
// a temp home) behind the fake host. The fake hands it `/skills/<name>/{open,save,reload}` and the
// room's websocket, so the editor, the host's rooms and its comment routing meet as in the app.
// Plugged into FakeRelayHost.extra.
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Duplex } from 'node:stream'

const SCRIPT = path.resolve(__dirname, '../../../linux/test/skills-test-host.ts')

/** One scripted answer: what a comment matching `match` gets from "Nova". */
export interface Play {
  match: string
  reply?: string
  /** `find: 'quote'` replaces the commented text. */
  edit?: { find?: string; replace?: string; after?: string; insert?: string }
  delay?: number
}

export class SkillsTestHost {
  /** Everything the host printed (deliveries, the agent's errors). */
  readonly log: string[] = []

  private constructor(
    private readonly child: ChildProcess,
    readonly skill: string,
    readonly port: number,
    /** SKILL.md on disk, as the host writes it. */
    readonly file: string,
    private readonly dir: string,
  ) {}

  /** Starts the host with `text` as skill `skill`'s SKILL.md and `playbook` (or a real omp) answering comments. */
  static async start(
    skill: string,
    text: string,
    agent: { playbook: Play[] } | 'omp',
  ): Promise<SkillsTestHost> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-skills-host-'))
    const file = path.join(dir, 'SKILL.md')
    fs.writeFileSync(file, text)
    const args = [SCRIPT, '--skill', skill, '--file', file]
    if (agent === 'omp') args.push('--agent', 'omp')
    else {
      const playbook = path.join(dir, 'playbook.json')
      fs.writeFileSync(playbook, JSON.stringify(agent.playbook))
      args.push('--agent', 'script', '--playbook', playbook)
    }
    const child = spawn('bun', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const log: string[] = []
    const { promise, resolve, reject } = Promise.withResolvers<{ port: number; file: string }>()
    const read = (chunk: Buffer): void => {
      const text = chunk.toString()
      log.push(text)
      const up = /listening (\d+) skill (\S+)/.exec(text)
      if (up) resolve({ port: Number(up[1]), file: up[2]! })
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.on('exit', (code) =>
      reject(new Error(`skills test host exited ${code}: ${log.join('')}`)),
    )
    const up = await promise
    const host = new SkillsTestHost(child, skill, up.port, up.file, dir)
    host.log.push(...log)
    child.stdout.on('data', (c: Buffer) => host.log.push(c.toString()))
    child.stderr.on('data', (c: Buffer) => host.log.push(c.toString()))
    return host
  }

  /** `POST /skills/<skill>/<verb>`: forwarded to the host. */
  http(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const match = /^\/skills\/([^/]+)\/(open|save|reload)$/.exec(url.pathname)
    if (req.method !== 'POST' || !match || decodeURIComponent(match[1]!) !== this.skill)
      return false
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: this.port,
        method: 'POST',
        path: req.url,
        headers: { 'content-type': 'application/json' },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      },
    )
    upstream.on('error', () => res.writeHead(502).end())
    req.pipe(upstream)
    return true
  }

  /** `GET /skills/<skill>/ws`: the socket piped to the host's room. */
  upgrade(req: http.IncomingMessage, socket: Duplex): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const name = /^\/skills\/([^/]+)\/ws$/.exec(url.pathname)?.[1]
    if (name === undefined || decodeURIComponent(name) !== this.skill) return false
    const upstream = net.connect(this.port, '127.0.0.1', () => {
      const head = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        head.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      upstream.write(`${head.join('\r\n')}\r\n\r\n`)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    return true
  }

  /** The comment threads the host keeps for the skill, as written to its file. */
  threadsFile(): unknown {
    const file = path.join(
      path.dirname(this.file),
      '../../../../skill-threads',
      `${this.skill}.json`,
    )
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as unknown) : null
  }

  close(): void {
    this.child.kill('SIGTERM')
    fs.rmSync(this.dir, { recursive: true, force: true })
  }
}
