// The Host's supervision of the MCP HTTP entrance (MCP HTTP F1 design §3): a fake spawn and a fake clock,
// a real token file in a temporary profile.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMcpHttpSupervisor, MCP_HTTP_RETRY_MS, NO_CLI_PATHS, type McpHttpChild } from './mcpHttp'
import type { McpHttpSettings } from '../core/settings/mcpHttp'
import type { McpHttpState } from '../core/host/protocol'
import { tokenPath } from '../core/mcp/httpToken'

class FakeChild extends EventEmitter implements McpHttpChild {
  readonly pid = 4242
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  stdinEnded = false
  killed = false
  exited = false
  constructor(
    readonly exec: string,
    readonly args: string[],
    readonly opts: { env: NodeJS.ProcessEnv; windowsHide: boolean; stdio: unknown; cwd: string },
    endsOnStdin: boolean
  ) {
    super()
    this.stdin.on('finish', () => {
      this.stdinEnded = true
      if (endsOnStdin) this.exit(0)
    })
  }
  kill(): boolean {
    this.killed = true
    this.exit(null)
    return true
  }
  ready(port: number, addresses?: string[]): void {
    this.stdout.write(`${JSON.stringify({ ready: true, port, ...(addresses ? { addresses } : {}) })}\n`)
  }
  fail(code: string, message: string, exitCode = 1): void {
    this.stdout.write(`${JSON.stringify({ error: code, message })}\n`)
    // Only after the line has been read, the way a real child's 'close' follows its last output.
    setImmediate(() => this.exit(exitCode))
  }
  exit(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code, code === null ? 'SIGTERM' : null)
    this.emit('close', code, code === null ? 'SIGTERM' : null)
  }
}

/** A clock whose timers run only when the test moves it. A restart a timer starts runs on after it (the token
 *  file is real), so a test waits for its child with `vi.waitFor`. */
const fakeClock = (): {
  now(): number
  setTimer(fn: () => void, ms: number): () => void
  advance(ms: number): Promise<void>
  pending(): number[]
} => {
  let t = 0
  let timers: Array<{ due: number; fn: () => void; ms: number }> = []
  return {
    now: () => t,
    setTimer(fn, ms) {
      const timer = { due: t + ms, fn, ms }
      timers.push(timer)
      return () => {
        timers = timers.filter((x) => x !== timer)
      }
    },
    async advance(ms) {
      const end = t + ms
      for (;;) {
        const next = timers.filter((x) => x.due <= end).sort((a, b) => a.due - b.due)[0]
        if (!next) break
        timers = timers.filter((x) => x !== next)
        t = next.due
        next.fn()
      }
      t = end
    },
    pending: () => timers.map((x) => x.ms)
  }
}

/** Lets the supervisor's promise chain and the fake streams run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

const CLI = { exec: '/app/astera', entry: '/app/out/main/cli.js', skills: '/app/skills' }
const on = (over: Partial<McpHttpSettings> = {}): McpHttpSettings => ({ enabled: true, port: 7871, lan: false, hosts: [], ...over })

let profileDir: string
beforeEach(() => {
  profileDir = mkdtempSync(path.join(os.tmpdir(), 'astera-mcphttp-'))
})
afterEach(() => {
  rmSync(profileDir, { recursive: true, force: true })
})

const rig = (
  o: { settings?: McpHttpSettings; cli?: typeof CLI | null; endsOnStdin?: boolean; settingsThrow?: boolean; firstSpawnThrows?: boolean } = {}
): {
  sup: ReturnType<typeof createMcpHttpSupervisor>
  children: FakeChild[]
  pushes: McpHttpState[]
  output: string[]
  logs: string[]
  clock: ReturnType<typeof fakeClock>
  set(s: McpHttpSettings): void
  last(): FakeChild
} => {
  let settings = o.settings ?? on()
  const children: FakeChild[] = []
  const pushes: McpHttpState[] = []
  const output: string[] = []
  const logs: string[] = []
  const clock = fakeClock()
  let spawned = 0
  const sup = createMcpHttpSupervisor({
    settings: async () => {
      if (o.settingsThrow) throw new Error('unreadable')
      return settings
    },
    cli: o.cli === undefined ? CLI : o.cli,
    profileDir,
    hostAddress: '//./pipe/astera-host-test',
    env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', ASTERA_HOST_CLI_EXEC: '/app/astera' },
    spawn: (exec, args, opts) => {
      if (o.firstSpawnThrows && spawned++ === 0) throw new Error('spawn EACCES')
      const c = new FakeChild(exec, args, opts as FakeChild['opts'], o.endsOnStdin ?? true)
      children.push(c)
      return c
    },
    now: clock.now,
    setTimer: clock.setTimer,
    push: (s) => pushes.push(s),
    output: { write: (m) => output.push(m) },
    log: (m) => logs.push(m)
  })
  return { sup, children, pushes, output, logs, clock, set: (s) => (settings = s), last: () => children[children.length - 1] }
}

describe('the MCP HTTP supervisor', () => {
  it('is off with the defaults before anything is read, and stays off while disabled', async () => {
    const r = rig({ settings: on({ enabled: false, port: 9000, lan: true }) })
    expect(r.sup.status()).toEqual({ state: 'off', lan: false, port: 7871 })
    await r.sup.reload()
    expect(r.children).toHaveLength(0)
    expect(r.sup.status()).toEqual({ state: 'off', lan: true, port: 9000 })
  })

  it('starts the entrance on enable with the CLI paths, the token file and a hidden window', async () => {
    const r = rig()
    await r.sup.reload()
    expect(r.children).toHaveLength(1)
    const c = r.last()
    expect(c.exec).toBe(CLI.exec)
    expect(c.args).toEqual([CLI.entry, 'mcp', 'http', '--port', '7871', '--bind', '127.0.0.1', '--token-file', tokenPath(profileDir)])
    expect(c.opts.windowsHide).toBe(true)
    expect(c.opts.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(c.opts.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(c.opts.env.ASTERA_PROFILE_DIR).toBe(profileDir)
    expect(c.opts.env.ASTERA_HOST).toBe('//./pipe/astera-host-test')
    expect(c.opts.env.ASTERA_HOST_CLI_EXEC).toBeUndefined()
    expect(c.opts.env.PATH).toBe('/bin')
    // The token exists before the child reads it (Task 1's ensureToken).
    expect(readFileSync(tokenPath(profileDir), 'utf8').trim()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(r.sup.status()).toEqual({ state: 'starting', lan: false, port: 7871 })
  })

  it('binds every address and passes the typed hosts only when other devices are allowed', async () => {
    const r = rig({ settings: on({ lan: true, hosts: ['my-pc', ' pc.tailnet.ts.net ', '', 'bad,host'] }) })
    await r.sup.reload()
    expect(r.last().args.slice(3)).toEqual(['--port', '7871', '--bind', '0.0.0.0', '--token-file', tokenPath(profileDir), '--hosts', 'my-pc,pc.tailnet.ts.net'])
    const local = rig({ settings: on({ lan: false, hosts: ['my-pc'] }) })
    await local.sup.reload()
    expect(local.last().args).not.toContain('--hosts')
  })

  it('is running with its url once the child prints its ready line, and pushes every change once', async () => {
    const r = rig()
    await r.sup.reload()
    r.last().ready(7871)
    await settle()
    expect(r.sup.status()).toEqual({ state: 'running', url: 'http://127.0.0.1:7871/mcp', lan: false, port: 7871 })
    expect(r.pushes.map((s) => s.state)).toEqual(['starting', 'running'])
    // A reload with nothing changed changes nothing and pushes nothing.
    await r.sup.reload()
    expect(r.children).toHaveLength(1)
    expect(r.pushes).toHaveLength(2)
  })

  it('lists the URLs other devices can use from the ready line while they are allowed, with the typed names', async () => {
    const r = rig({ settings: on({ lan: true, hosts: ['box.ts.net'] }) })
    await r.sup.reload()
    r.last().ready(7871, ['127.0.0.1', 'localhost', 'box.ts.net', '100.90.1.2', '192.168.1.5', 'fe80::2'])
    await settle()
    expect(r.sup.status()).toEqual({
      state: 'running',
      url: 'http://127.0.0.1:7871/mcp',
      urls: [
        { url: 'http://192.168.1.5:7871/mcp', kind: 'lan' },
        { url: 'http://100.90.1.2:7871/mcp', kind: 'tailscale' },
        { url: 'http://box.ts.net:7871/mcp', kind: 'name' }
      ],
      lan: true,
      port: 7871
    })
  })

  it('lists no URLs while other devices are not allowed, even when the ready line names addresses', async () => {
    const r = rig({ settings: on({ lan: false, hosts: ['box'] }) })
    await r.sup.reload()
    r.last().ready(7871, ['127.0.0.1', 'localhost', '192.168.1.5'])
    await settle()
    expect(r.sup.status()).toEqual({ state: 'running', url: 'http://127.0.0.1:7871/mcp', lan: false, port: 7871 })
  })

  it('lists no URLs from an older child whose ready line names no addresses, nor from a malformed list', async () => {
    const r = rig({ settings: on({ lan: true }) })
    await r.sup.reload()
    r.last().ready(7871)
    await settle()
    expect(r.sup.status()).toEqual({ state: 'running', url: 'http://127.0.0.1:7871/mcp', lan: true, port: 7871 })
    const bad = rig({ settings: on({ lan: true }) })
    await bad.sup.reload()
    bad.last().stdout.write(`${JSON.stringify({ ready: true, port: 7871, addresses: ['192.168.1.5', 7] })}\n`)
    await settle()
    expect(bad.sup.status()).toEqual({ state: 'running', url: 'http://127.0.0.1:7871/mcp', lan: true, port: 7871 })
  })

  it('pushes again when only the URLs changed, and not for the same URLs', async () => {
    const r = rig({ settings: on({ lan: true }) })
    await r.sup.reload()
    r.last().ready(7871, ['192.168.1.5'])
    await settle()
    expect(r.pushes).toHaveLength(2)
    // The same child's line again (not something a child does, but the compare is what is under test).
    r.last().ready(7871, ['192.168.1.5'])
    await settle()
    expect(r.pushes).toHaveLength(2)
    r.last().ready(7871, ['192.168.1.5', '10.0.0.2'])
    await settle()
    expect(r.pushes).toHaveLength(3)
    expect(r.pushes[2].urls).toEqual([
      { url: 'http://192.168.1.5:7871/mcp', kind: 'lan' },
      { url: 'http://10.0.0.2:7871/mcp', kind: 'lan' }
    ])
  })

  it('writes the child output to its own log, not the Host log', async () => {
    const r = rig()
    await r.sup.reload()
    r.last().stderr.write('astera mcp http: listening on 127.0.0.1:7871\n')
    r.last().ready(7871)
    await settle()
    expect(r.output.some((l) => l.includes('astera mcp http: listening on 127.0.0.1:7871'))).toBe(true)
    expect(r.logs.some((l) => l.includes('astera mcp http:'))).toBe(false)
  })

  it('restarts an unexpected exit after 1 s, 2 s, 5 s, then 30 s and longer', async () => {
    const r = rig()
    await r.sup.reload()
    r.last().ready(7871)
    await settle()
    const delays: number[] = []
    for (let i = 0; i < 5; i++) {
      r.last().exit(3)
      await settle()
      expect(r.sup.status()).toMatchObject({ state: 'failed', error: 'the HTTP entrance exited with code 3' })
      const [delay] = r.clock.pending()
      delays.push(delay)
      const before = r.children.length
      await r.clock.advance(delay - 1)
      expect(r.children).toHaveLength(before)
      await r.clock.advance(1)
      await vi.waitFor(() => expect(r.children).toHaveLength(before + 1))
      expect(r.sup.status().state).toBe('starting')
    }
    expect(delays).toEqual([1000, 2000, 5000, 30_000, 60_000])
  })

  it('starts the backoff over once a child has stayed up', async () => {
    const r = rig()
    await r.sup.reload()
    r.last().exit(1)
    await settle()
    await r.clock.advance(1000)
    await vi.waitFor(() => expect(r.children).toHaveLength(2))
    r.last().exit(1)
    await settle()
    expect(r.clock.pending()).toEqual([2000])
    await r.clock.advance(2000)
    await vi.waitFor(() => expect(r.children).toHaveLength(3))
    r.last().ready(7871)
    await settle()
    await r.clock.advance(60_000)
    r.last().exit(1)
    await settle()
    expect(r.clock.pending()).toEqual([1000])
  })

  // Second pass H2-1: a port that stays taken was tried every 30 s for the Host's whole life, each try a new process.
  it('reports a port in use as failed and waits longer each time it is still taken, up to ten minutes', async () => {
    const r = rig()
    await r.sup.reload()
    const waits: number[] = []
    for (let i = 0; i < 7; i++) {
      r.last().fail('EADDRINUSE', 'in use')
      await settle()
      waits.push(r.clock.pending()[0])
      await r.clock.advance(r.clock.pending()[0])
      await vi.waitFor(() => expect(r.children).toHaveLength(i + 2))
    }
    expect(waits.slice(0, 5)).toEqual([30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000])
    expect(waits[6]).toBe(10 * 60_000)
  })

  it('an unnamed exit that keeps happening waits longer each time past the short tries', async () => {
    const r = rig()
    await r.sup.reload()
    const waits: number[] = []
    for (let i = 0; i < 9; i++) {
      r.last().exit(1)
      await settle()
      waits.push(r.clock.pending()[0])
      await r.clock.advance(r.clock.pending()[0])
      await vi.waitFor(() => expect(r.children).toHaveLength(i + 2))
    }
    expect(waits).toEqual([1_000, 2_000, 5_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 10 * 60_000])
  })

  it('a child that came up starts the port-taken waits again', async () => {
    const r = rig()
    await r.sup.reload()
    r.last().fail('EADDRINUSE', 'in use')
    await settle()
    await r.clock.advance(MCP_HTTP_RETRY_MS)
    await vi.waitFor(() => expect(r.children).toHaveLength(2))
    r.last().ready(7871)
    await settle()
    r.last().fail('EADDRINUSE', 'in use')
    await settle()
    expect(r.clock.pending()).toEqual([MCP_HTTP_RETRY_MS])
  })

  it('reports a port in use as failed, not in a tight loop', async () => {
    const r = rig()
    await r.sup.reload()
    r.last().fail('EADDRINUSE', 'listen EADDRINUSE: address already in use 127.0.0.1:7871')
    await settle()
    expect(r.sup.status()).toEqual({
      state: 'failed',
      error: 'EADDRINUSE: listen EADDRINUSE: address already in use 127.0.0.1:7871',
      lan: false,
      port: 7871
    })
    expect(r.clock.pending()).toEqual([MCP_HTTP_RETRY_MS])
    await r.clock.advance(MCP_HTTP_RETRY_MS)
    await vi.waitFor(() => expect(r.children).toHaveLength(2))
    r.last().fail('EADDRINUSE', 'again')
    await settle()
    expect(r.clock.pending()).toEqual([2 * MCP_HTTP_RETRY_MS])
  })

  it('stops the child when disabled, by ending its stdin', async () => {
    const r = rig()
    await r.sup.reload()
    r.last().ready(7871)
    await settle()
    r.set(on({ enabled: false }))
    await r.sup.reload()
    expect(r.last().stdinEnded).toBe(true)
    expect(r.last().killed).toBe(false)
    expect(r.sup.status()).toEqual({ state: 'off', lan: false, port: 7871 })
    // An expected exit is not restarted.
    expect(r.clock.pending()).toEqual([])
  })

  it('kills a child that does not leave within the grace after its stdin ended', async () => {
    const r = rig({ endsOnStdin: false })
    await r.sup.reload()
    r.set(on({ enabled: false }))
    const stopped = r.sup.reload()
    await settle()
    expect(r.last().stdinEnded).toBe(true)
    expect(r.last().killed).toBe(false)
    await r.clock.advance(5000)
    await stopped
    expect(r.last().killed).toBe(true)
    expect(r.sup.status().state).toBe('off')
  })

  it('restarts with the new arguments when the settings change', async () => {
    const r = rig()
    await r.sup.reload()
    r.last().ready(7871)
    await settle()
    r.set(on({ port: 9100, lan: true, hosts: ['pc'] }))
    await r.sup.reload()
    expect(r.children).toHaveLength(2)
    expect(r.children[0].stdinEnded).toBe(true)
    expect(r.last().args).toEqual([CLI.entry, 'mcp', 'http', '--port', '9100', '--bind', '0.0.0.0', '--token-file', tokenPath(profileDir), '--hosts', 'pc'])
    r.last().ready(9100)
    await settle()
    expect(r.sup.status()).toEqual({ state: 'running', url: 'http://127.0.0.1:9100/mcp', lan: true, port: 9100 })
  })

  it('retries at once on a person’s reload while failed with the same settings, cancelling the wait', async () => {
    const r = rig()
    await r.sup.reload()
    r.last().fail('EADDRINUSE', 'in use')
    await settle()
    await r.sup.reload({ retry: true })
    expect(r.children).toHaveLength(2)
    expect(r.clock.pending()).toEqual([])
  })

  it('a plain reload (an app greeting) while failed keeps the 30 s cadence and the backoff', async () => {
    const r = rig()
    await r.sup.reload()
    r.last().fail('EADDRINUSE', 'in use')
    await settle()
    await r.sup.reload()
    expect(r.children).toHaveLength(1)
    expect(r.clock.pending()).toEqual([MCP_HTTP_RETRY_MS])
    const crash = rig()
    await crash.sup.reload()
    crash.last().exit(1)
    await settle()
    await crash.clock.advance(1000)
    await vi.waitFor(() => expect(crash.children).toHaveLength(2))
    crash.last().exit(1)
    await settle()
    await crash.sup.reload()
    expect(crash.clock.pending()).toEqual([2000])
    // A person's retry starts over: the next unexpected end waits 1 s again.
    await crash.sup.reload({ retry: true })
    expect(crash.children).toHaveLength(3)
    crash.last().exit(1)
    await settle()
    expect(crash.clock.pending()).toEqual([1000])
  })

  // Second pass H2-1: output with no newline was held whole for as long as the child printed.
  it('logs a line with no newline in pieces instead of holding it whole', async () => {
    const r = rig()
    await r.sup.reload()
    r.last().stderr.write('x'.repeat(200_000))
    await settle()
    expect(r.output.filter((l) => l.includes('x'.repeat(64 * 1024)))).toHaveLength(3)
  })

  it('keeps a stderr line whole across chunks', async () => {
    const r = rig()
    await r.sup.reload()
    r.last().stderr.write('astera mcp http: listen')
    r.last().stderr.write(`ing on 127.0.0.1:7871${'\n'}second`)
    r.last().stderr.write(` line${'\n'}`)
    await settle()
    expect(r.output).toContain('astera mcp http: listening on 127.0.0.1:7871')
    expect(r.output).toContain('second line')
  })

  it('reports failed without CLI paths, and spawns nothing', async () => {
    const r = rig({ cli: null })
    await r.sup.reload()
    expect(r.children).toHaveLength(0)
    expect(r.sup.status()).toEqual({ state: 'failed', error: NO_CLI_PATHS, lan: false, port: 7871 })
    expect(NO_CLI_PATHS).toBe('this Host cannot start the HTTP entrance')
    expect(r.clock.pending()).toEqual([])
  })

  it('keeps what it has when the settings cannot be read', async () => {
    const r = rig({ settingsThrow: true })
    await r.sup.reload()
    expect(r.sup.status().state).toBe('off')
    expect(r.logs.some((l) => l.includes('unreadable'))).toBe(true)
  })

  it('a spawn that throws is failed and retried with the backoff', async () => {
    const r = rig({ firstSpawnThrows: true })
    await r.sup.reload()
    expect(r.sup.status()).toMatchObject({ state: 'failed', error: 'could not start the HTTP entrance: Error: spawn EACCES' })
    expect(r.clock.pending()).toEqual([1000])
    await r.clock.advance(1000)
    await vi.waitFor(() => expect(r.children).toHaveLength(1))
    await r.sup.stop()
  })

  it('stop ends the child and cancels a pending restart, and nothing starts after it', async () => {
    const r = rig()
    await r.sup.reload()
    r.last().exit(1)
    await settle()
    expect(r.clock.pending()).toEqual([1000])
    await r.sup.stop()
    expect(r.clock.pending()).toEqual([])
    await r.sup.reload()
    expect(r.children).toHaveLength(1)
    const live = rig()
    await live.sup.reload()
    await live.sup.stop()
    expect(live.last().stdinEnded).toBe(true)
    expect(live.sup.status().state).toBe('off')
  })
})
