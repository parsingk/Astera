// The Host's supervision of its Remote Gateway (remote runtime design §2.3): a fake spawn and a fake clock, as the MCP
// HTTP supervisor's tests have.
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createGatewaySupervisor, type GatewayChild, type GatewayState } from './gatewaySupervisor'
import type { RemoteSettings } from '../core/remote/settings'

class FakeChild extends EventEmitter implements GatewayChild {
  readonly pid = 77
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false
  exited = false
  constructor(readonly args: string[], readonly env: NodeJS.ProcessEnv) {
    super()
    this.stdin.on('finish', () => this.exit(0))
  }
  kill(): boolean {
    this.killed = true
    this.exit(null)
    return true
  }
  frame(m: unknown): void {
    this.stdout.write(`${JSON.stringify(m)}\n`)
  }
  exit(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code, code === null ? 'SIGTERM' : null)
    this.emit('close', code, code === null ? 'SIGTERM' : null)
  }
}

const fakeClock = () => {
  let t = 0
  let timers: Array<{ due: number; fn: () => void; ms: number }> = []
  return {
    now: () => t,
    setTimer(fn: () => void, ms: number) {
      const timer = { due: t + ms, fn, ms }
      timers.push(timer)
      return () => {
        timers = timers.filter((x) => x !== timer)
      }
    },
    async advance(ms: number) {
      const end = t + ms
      for (;;) {
        const next = timers.filter((x) => x.due <= end).sort((a, b) => a.due - b.due)[0]
        if (!next) break
        timers = timers.filter((x) => x !== next)
        t = next.due
        next.fn()
        await settle()
      }
      t = end
    }
  }
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

const CLI = { exec: '/app/astera', entry: '/app/out/main/cli.js', skills: '/app/skills' }
const on = (over: Partial<RemoteSettings> = {}): RemoteSettings => ({ enabled: true, listen: '100.64.0.5', port: 47831, ...over })

const rig = (o: { settings?: RemoteSettings } = {}) => {
  let settings = o.settings ?? on()
  const children: FakeChild[] = []
  const pushes: GatewayState[] = []
  const errLog: string[] = []
  const logs: string[] = []
  const attached: Array<{ linkGen: number; stdout: string[]; detached: boolean; events: { ready(f: never): void; failed(f: never): void; hardCap(): void } }> = []
  const clock = fakeClock()
  const sup = createGatewaySupervisor({
    settings: async () => settings,
    cli: CLI,
    profileDir: '/p',
    env: { PATH: '/bin', ASTERA_HOST_CLI_EXEC: '/app/astera' },
    spawn: (_exec, args, opts) => {
      const c = new FakeChild(args, opts.env)
      children.push(c)
      return c
    },
    now: clock.now,
    setTimer: clock.setTimer,
    push: (s) => pushes.push(s),
    attach: (child, linkGen, events) => {
      const a = { linkGen, stdout: [] as string[], detached: false, events: events as never }
      child.stdout.on('data', (d: Buffer) => {
        a.stdout.push(d.toString())
        for (const line of d.toString().split('\n').filter(Boolean)) {
          const f = JSON.parse(line) as { t: string }
          if (f.t === 'gateway-ready') events.ready(f as never)
          if (f.t === 'gateway-failed') events.failed(f as never)
        }
      })
      attached.push(a)
      return { closeConns: () => {}, detach: () => void (a.detached = true) }
    },
    errLog: { write: (m) => errLog.push(m) },
    log: (m) => logs.push(m)
  })
  return { sup, children, pushes, errLog, logs, attached, clock, set: (s: RemoteSettings) => (settings = s), last: () => children[children.length - 1] }
}

describe('the Gateway supervisor (remote runtime design §2.3)', () => {
  it('is disabled and spawns nothing while Remote is off', async () => {
    const r = rig({ settings: on({ enabled: false }) })
    await r.sup.reload()
    expect(r.sup.status()).toMatchObject({ state: 'disabled' })
    expect(r.children).toHaveLength(0)
  })
  it('spawns `runtime gateway` with the listen settings, and is ready on its frame', async () => {
    const r = rig()
    await r.sup.reload()
    expect(r.last().args).toEqual([CLI.entry, 'runtime', 'gateway', '--listen', '100.64.0.5', '--port', '47831'])
    expect(r.last().env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', ASTERA_PROFILE_DIR: '/p' })
    expect(r.sup.status()).toMatchObject({ state: 'starting' })
    r.last().frame({ t: 'gateway-ready', port: 47831, address: '100.64.0.5', fingerprint: 'fp' })
    await settle()
    expect(r.sup.status()).toEqual({ state: 'ready', listen: '100.64.0.5', port: 47831, fingerprint: 'fp' })
  })
  it('a bind failure is failed with its code and tried again on the 30 s cadence', async () => {
    const r = rig()
    await r.sup.reload()
    r.last().frame({ t: 'gateway-failed', code: 'BIND_IN_USE', message: 'in use' })
    await settle()
    r.last().exit(1)
    await settle()
    expect(r.sup.status()).toMatchObject({ state: 'failed', code: 'BIND_IN_USE' })
    await r.clock.advance(29_000)
    expect(r.children).toHaveLength(1)
    await r.clock.advance(1_000)
    expect(r.children).toHaveLength(2)
  })
  // Phase 3 minor: an app greeting reloads too, and must not cut a failed Gateway's cadence short; the person's own
  // `runtime start` (runtime-reload) does try again at once.
  it('a plain reload leaves a failed Gateway to its cadence; reload({ now: true }) tries again at once', async () => {
    const r = rig()
    await r.sup.reload()
    r.last().frame({ t: 'gateway-failed', code: 'BIND_IN_USE', message: 'in use' })
    await settle()
    r.last().exit(1)
    await settle()
    await r.sup.reload()
    expect(r.children).toHaveLength(1)
    await r.sup.reload({ now: true })
    expect(r.children).toHaveLength(2)
  })
  it('restarts a crashed Gateway after 1, 2 then 5 seconds, each with a new link generation', async () => {
    const r = rig()
    await r.sup.reload()
    for (const wait of [1_000, 2_000, 5_000]) {
      r.last().exit(1)
      await settle()
      expect(r.sup.status()).toMatchObject({ state: 'failed' })
      await r.clock.advance(wait - 1)
      const before = r.children.length
      await r.clock.advance(1)
      expect(r.children.length).toBe(before + 1)
    }
    expect(r.attached.map((a) => a.linkGen)).toEqual([1, 2, 3, 4])
    expect(r.attached.slice(0, 3).every((a) => a.detached)).toBe(true)
  })
  it('writes stderr to the gateway log redacted, and never logs stdout (Review Focus 4)', async () => {
    const r = rig()
    await r.sup.reload()
    r.last().stderr.write('bad frame {"t":"auth","token":"SECRET-TOKEN-VALUE"}\n')
    r.last().frame({ t: 'gateway-ready', port: 1, address: 'a', fingerprint: 'f' })
    await settle()
    const all = [...r.errLog, ...r.logs].join('\n')
    expect(all).not.toContain('SECRET-TOKEN-VALUE')
    expect(r.errLog.some((l) => l.includes('[redacted]'))).toBe(true)
    expect(all).not.toContain('gateway-ready')
  })
  // Phase 3 minor: a stderr that never ends a line cannot grow without bound; it is written in pieces.
  it('writes a stderr line with no end in pieces of at most 64 KiB', async () => {
    const r = rig()
    await r.sup.reload()
    r.last().stderr.write('x'.repeat(200 * 1024))
    await settle()
    expect(r.errLog.length).toBeGreaterThanOrEqual(3)
    for (const m of r.errLog) expect(m.length).toBeLessThanOrEqual(64 * 1024 + 64)
  })
  it('does not restart for a reload with the same settings, and restarts for new ones', async () => {
    const r = rig()
    await r.sup.reload()
    await r.sup.reload()
    expect(r.children).toHaveLength(1)
    r.set(on({ port: 50000 }))
    await r.sup.reload()
    expect(r.children).toHaveLength(2)
    expect(r.children[0].exited).toBe(true)
  })
  it('stops by ending stdin, and kill() restarts it now (the hard cap, DC-2)', async () => {
    const r = rig()
    await r.sup.reload()
    r.sup.kill()
    await settle()
    expect(r.children[0].killed).toBe(true)
    await r.clock.advance(1_000)
    expect(r.children).toHaveLength(2)
    await r.sup.stop()
    expect(r.children[1].exited).toBe(true)
    expect(r.children[1].killed).toBe(false)
    expect(r.sup.status()).toMatchObject({ state: 'disabled' })
  })
  it('says why when this Host has no CLI paths', async () => {
    const r = rig()
    const sup = createGatewaySupervisor({ settings: async () => on(), cli: null, profileDir: '/p', env: {}, push: () => {}, attach: () => ({ closeConns: () => {}, detach: () => {} }), log: () => {} })
    await sup.reload()
    expect(sup.status()).toMatchObject({ state: 'failed', code: 'NO_CLI_PATHS' })
    expect(r.children).toHaveLength(0)
  })
})
