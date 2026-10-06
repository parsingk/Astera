import { describe, it, expect, vi, afterEach } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Cdp, DeskHandle } from '../../core/workspace/helpers'
import type { DeskShot, DeskWindow } from '../../core/workspace/protocol'
import type { DesktopHelper } from './desktopHelper'
import { DEFAULT_APP_SIZE } from '../../core/workspace/size'
import { DISPOSE_CAP_MS, FRAME_EVERY_MS, REFIT_AFTER_MS, REFIT_TRIES, createWorkspaceManager, disposeWithin, type WorkspaceEvent, type WorkspaceManager, type WorkspaceManagerDeps } from './manager'

// Records the child processes the script runner spawns (scriptWorker.ts), delegating to the real spawn.
const spawned = vi.hoisted(() => ({ children: [] as import('node:child_process').ChildProcess[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const spawn = ((...a: Parameters<typeof real.spawn>) => {
    const c = (real.spawn as (...b: unknown[]) => import('node:child_process').ChildProcess)(...a)
    spawned.children.push(c)
    return c
  }) as typeof real.spawn
  return { ...real, spawn, default: { ...real, spawn } }
})

class FakeDesk implements DesktopHelper {
  static made: FakeDesk[] = []
  pid: number
  startedAt = 2_000
  launches: Array<{ command: string; cwd: string; env: Record<string, string> }> = []
  kills: number[] = []
  killStarts: number[] = []
  killFails = false
  closed = false
  private exits: Array<(why: string) => void> = []
  constructor(readonly name: string) {
    this.pid = 9000 + FakeDesk.made.length
    FakeDesk.made.push(this)
  }
  alive(): boolean {
    return !this.closed
  }
  onExit(cb: (why: string) => void): void {
    this.exits.push(cb)
  }
  /** While set, every launch waits for it after being recorded: an app that is still starting. */
  static hold: Promise<void> | null = null
  async launch(a: { command: string; cwd: string; env: Record<string, string> }) {
    this.launches.push(a)
    if (FakeDesk.hold) await FakeDesk.hold
    return { pid: 500 + FakeDesk.made.indexOf(this) * 10 + this.launches.length, startedAt: 3_000 }
  }
  async kill(pid: number, startedAt: number) {
    this.kills.push(pid)
    this.killStarts.push(startedAt)
    if (this.killFails) throw new Error('the helper is gone')
  }
  async windows(): Promise<DeskWindow[]> {
    return []
  }
  async shot(): Promise<DeskShot> {
    return { data: '/9j/', width: 10, height: 10, title: 'T' }
  }
  async keys() {}
  fits: Array<{ title?: string; width: number; height: number }> = []
  async fit(a: { title?: string; width: number; height: number }) {
    this.fits.push(a)
    return { width: a.width, height: a.height }
  }
  closes = 0
  async close() {
    this.closes += 1
    this.closed = true
  }
  die(why: string): void {
    this.closed = true
    for (const cb of this.exits) cb(why)
  }
}

const fakeCdp = (o: { viewport?: { width: number; height: number }; dpr?: number; pageReads?: Array<[number, number]>; pageAfter?: [number, number] } = {}): Cdp & { closed: boolean; calls: string[]; sent: Array<{ method: string; params?: Record<string, unknown> }>; viewport: { width: number; height: number } } => {
  const c = {
    closed: false,
    calls: [] as string[],
    sent: [] as Array<{ method: string; params?: Record<string, unknown> }>,
    viewport: o.viewport ?? { width: 1920, height: 1080 },
    send: async (method: string, params?: Record<string, unknown>) => {
      c.calls.push(method)
      c.sent.push({ method, params })
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: c.viewport.width, clientHeight: c.viewport.height } }
      if (method === 'Runtime.evaluate' && params?.expression === 'window.devicePixelRatio') return { result: { value: o.dpr ?? 1 } }
      // The page's own size, read while an override is checked: the reads given, then `pageAfter`.
      if (method === 'Runtime.evaluate' && params?.expression === '[window.innerWidth, window.innerHeight]' && o.pageReads)
        return { result: { value: o.pageReads.shift() ?? o.pageAfter } }
      if (method === 'Page.captureScreenshot') return { data: '/9j/frame' }
      return {}
    },
    waitEvent: async () => ({}),
    consoleErrors: () => [],
    close: () => {
      c.closed = true
    }
  }
  return c
}

// Ruling F7: every manager a test makes is disposed (so no record write lands after its folder is
// gone) and every temp folder it made is removed, however many rigs one test builds.
const dirs: string[] = []
const managers: WorkspaceManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.dispose()
  FakeDesk.made = []
  FakeDesk.hold = null
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

// A script runs in a child process of its own (scriptWorker.ts), which has to start before the script
// reaches any helper. In a full run the slowest files start together, and that start alone took past
// vi.waitFor's 1 s default, so the test saw a helper "never called". A wait for the script to reach a
// helper gets the same 15 s the launch-wait tests below give it, and its test gets that plus its own 10 s.
const SCRIPT_START_MS = 15_000
const reachesHelper = { timeout: SCRIPT_START_MS, interval: 20 }
const STARTS_A_SCRIPT = { timeout: SCRIPT_START_MS + 10_000 }

const rig = async (over: Partial<WorkspaceManagerDeps> = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-ws-'))
  dirs.push(dir)
  const events: WorkspaceEvent[] = []
  const ticks: Array<{ ms: number; fn: () => void; live: boolean }> = []
  let clock = 1_000_000
  const deps: WorkspaceManagerDeps = {
    platform: 'win32',
    env: {},
    recordFile: path.join(dir, 'orch', 'workspaces.json'),
    shotsDir: path.join(dir, 'shots'),
    enabled: async () => true,
    guide: () => '# guide',
    sessionCwd: async (id) => (id.startsWith('s') ? path.join(dir, 'proj') : null),
    resolveLaunch: async ({ cwd, spec }) => ({ command: 'command' in spec ? spec.command : 'npm run dev', cwd, env: {} }),
    startDesk: vi.fn(async (name: string) => new FakeDesk(name)),
    connectCdp: vi.fn(async () => fakeCdp()),
    freePort: (() => {
      let p = 9300
      return async () => ++p
    })(),
    killTree: vi.fn(async () => {}),
    startTimes: vi.fn(async () => new Map<number, number>()),
    emit: (e) => events.push(e),
    hasWatchers: () => true,
    log: () => {},
    now: () => clock,
    every: (ms, fn) => {
      const t = { ms, fn, live: true }
      ticks.push(t)
      return () => {
        t.live = false
      }
    },
    ...over
  }
  const m = createWorkspaceManager(deps)
  managers.push(m)
  const tick = (ms: number): void => {
    clock += ms
    for (const t of [...ticks]) if (t.live && t.ms === ms) t.fn()
  }
  const file = async (): Promise<unknown> => JSON.parse(await fs.readFile(deps.recordFile, 'utf8'))
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20))
  return { m, deps, events, tick, file, settle }
}

const body = (r: { status: number; body: unknown }) => r.body as { log: string[]; error?: { message: string; at: string } }

describe('refusals', () => {
  it('an unsupported platform, switched off, unreadable settings, and an unknown session', async () => {
    const { m: other } = await rig({ platform: 'freebsd' })
    expect(await other.run('s1', 'log(1)')).toMatchObject({ status: 409, body: { error: expect.stringContaining('does not run on freebsd') } })
    const { m: off } = await rig({ enabled: async () => false })
    expect(await off.run('s1', 'log(1)')).toEqual({ status: 409, body: { error: 'agent app workspace is off' } })
    const { m: broken } = await rig({
      enabled: async () => {
        throw new Error('app-settings.json is not a valid settings file; open Astera to repair it')
      }
    })
    expect(await broken.run('s1', 'log(1)')).toMatchObject({ status: 409, body: { repair: 'app-settings.json' } })
    const { m } = await rig()
    expect(await m.run('x-unknown', 'log(1)')).toEqual({ status: 404, body: { error: 'no such session' } })
  })

  it('a script that launches nothing opens no desktop and sends no event', async () => {
    const { m, events, deps } = await rig()
    expect(await m.run('s1', "log('hi')")).toEqual({ status: 200, body: { log: ['hi'] } })
    expect(deps.startDesk).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect(m.list()).toEqual([])
  })
})

describe('Linux and macOS', () => {
  it('on Linux, refuses with the missing tools and the install line, before anything starts (L1)', async () => {
    const linuxTools = vi.fn(async () => ({ missing: ['xdotool' as const], installLine: 'sudo apt-get install -y xdotool' }))
    const { m, deps } = await rig({ platform: 'linux', linuxTools })
    expect(await m.run('s1', "await launch({ command: 'app' })")).toEqual({
      status: 409,
      body: { error: 'app js: the agent app workspace on Linux needs xdotool, and it is not installed here. Install it with: sudo apt-get install -y xdotool' }
    })
    expect(linuxTools).toHaveBeenCalledTimes(1)
    expect(deps.startDesk).not.toHaveBeenCalled()
  })

  it('on Linux with every tool there, runs over SSH too (L2)', async () => {
    const { m } = await rig({ platform: 'linux', env: { SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }, linuxTools: async () => ({ missing: [], installLine: '' }) })
    expect(await m.run('s1', "log('ok')")).toEqual({ status: 200, body: { log: ['ok'] } })
  })

  it('a tool check that fails is logged and refuses nothing (R8)', async () => {
    const log: string[] = []
    const { m } = await rig({
      platform: 'linux',
      log: (x) => log.push(x),
      linuxTools: async () => {
        throw new Error('EACCES /usr/bin')
      }
    })
    expect((await m.run('s1', "log('ok')")).status).toBe(200)
    expect(log.some((l) => l.includes('the Linux tool check failed') && l.includes('EACCES'))).toBe(true)
  })

  it('a tool check that throws at once is logged and refuses nothing (R8)', async () => {
    const log: string[] = []
    const { m } = await rig({
      platform: 'linux',
      log: (x) => log.push(x),
      linuxTools: () => {
        throw new Error('EACCES /usr/bin')
      }
    })
    expect((await m.run('s1', "log('ok')")).status).toBe(200)
    expect(log.some((l) => l.includes('the Linux tool check failed') && l.includes('EACCES'))).toBe(true)
  })

  it('with the setting off, answers that it is off before checking the Linux tools', async () => {
    const linuxTools = vi.fn(async () => ({ missing: ['xdotool' as const], installLine: 'sudo apt-get install -y xdotool' }))
    const { m } = await rig({ platform: 'linux', enabled: async () => false, linuxTools })
    expect(await m.run('s1', 'log(1)')).toEqual({ status: 409, body: { error: 'agent app workspace is off' } })
    expect(linuxTools).not.toHaveBeenCalled()
  })

  it('over SSH on Windows, refuses for SSH even with the setting off, since turning it on would not help', async () => {
    const { m } = await rig({ platform: 'win32', env: { SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }, enabled: async () => false })
    expect(await m.run('s1', 'log(1)')).toMatchObject({ status: 409, body: { error: expect.stringContaining('SSH') } })
  })

  it('on macOS, refuses over SSH', async () => {
    const { m } = await rig({ platform: 'darwin', env: { SSH_TTY: '/dev/ttys001' } })
    expect(await m.run('s1', 'log(1)')).toMatchObject({ status: 409, body: { error: expect.stringContaining('SSH') } })
  })

  it('a desktop with no helper process records only the launched app (R7)', async () => {
    const startDesk = vi.fn(async (name: string) => Object.assign(new FakeDesk(`mac-bg-${name}`), { pid: null }) as unknown as DeskHandle)
    const { m, file, settle } = await rig({ platform: 'darwin', startDesk })
    expect((await m.run('s1', "await launch({ command: 'app' })")).status).toBe(200)
    await settle()
    // The launch record is a second write after the desktop's own; on a loaded CI runner it can land after
    // settle() (macOS CI saw `pids: []`), so wait for it rather than read once.
    await vi.waitFor(async () =>
      expect(await file()).toEqual({
        version: 1,
        workspaces: [{ sessionId: 's1', desktop: expect.stringMatching(/^mac-bg-astera-ws-/), pids: [{ pid: 501, startedAt: 3_000 }] }]
      })
    )
  })

  it('hands the platform to the helpers, so the launch hint names the port the POSIX way (R12)', async () => {
    const { m } = await rig({ platform: 'linux', connectCdp: vi.fn(async () => null) })
    const r = await m.run('s1', "await launch({ command: 'app' }, { waitMs: 0 })")
    expect(body(r).error?.message).toContain('--remote-debugging-port=$ASTERA_APP_CDP_PORT')
  })
})

describe('launch and the record file', () => {
  it('creates one desktop, records the launched pid then the helper pid, and tells the app', async () => {
    const { m, file, events } = await rig()
    const r = await m.run('s1', "log(await launch({ config: 'dev' }))")
    expect(r.status).toBe(200)
    expect(body(r).log).toEqual(['{"pid":501,"port":9301}'])
    await vi.waitFor(async () =>
      expect(await file()).toEqual({
        version: 1,
        workspaces: [{ sessionId: 's1', desktop: expect.stringMatching(/^astera-ws-/), pids: [{ pid: 501, startedAt: 3_000 }, { pid: 9000, startedAt: 2_000 }] }]
      })
    )
    expect(events.some((e) => e.kind === 'state' && e.open && e.sessionId === 's1')).toBe(true)
    expect(m.list()).toMatchObject([{ sessionId: 's1', running: false }])
  })

  it('a second script while one runs is refused', STARTS_A_SCRIPT, async () => {
    let release!: () => void
    const { m } = await rig({ connectCdp: vi.fn(() => new Promise<Cdp | null>((r) => { release = () => r(fakeCdp()) })) })
    const first = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(release).toBeTypeOf('function'), reachesHelper)
    expect(await m.run('s1', 'log(1)')).toEqual({ status: 409, body: { error: 'a script is already running' } })
    release()
    expect((await first).status).toBe(200)
  })

  it('two sessions are two desktops, and closing one leaves the other (Review Focus 5)', async () => {
    const { m, file } = await rig()
    await m.run('s1', "await launch({ command: 'a.exe' })")
    await m.run('s2', "await launch({ command: 'b.exe' })")
    expect(FakeDesk.made.map((d) => d.name)).toHaveLength(2)
    expect(new Set(FakeDesk.made.map((d) => d.name)).size).toBe(2)
    expect(await m.close('s1')).toBe(true)
    expect(FakeDesk.made[0].closed).toBe(true)
    expect(FakeDesk.made[0].kills).toEqual([501])
    expect(FakeDesk.made[0].killStarts).toEqual([3_000])
    expect(FakeDesk.made[1].closed).toBe(false)
    expect(m.list().map((w) => w.sessionId)).toEqual(['s2'])
    await vi.waitFor(async () => expect(((await file()) as { workspaces: Array<{ sessionId: string }> }).workspaces.map((w) => w.sessionId)).toEqual(['s2']))
  })

  it('close then launch in one script starts a fresh desktop (Review Focus 5)', async () => {
    const { m } = await rig()
    const r = await m.run('s1', "await launch({ command: 'a.exe' }); await close(); log(await launch({ command: 'a.exe' }))")
    expect(body(r).error).toBeUndefined()
    expect(FakeDesk.made).toHaveLength(2)
    expect(FakeDesk.made[0].closed).toBe(true)
    expect(FakeDesk.made[1].closed).toBe(false)
    expect(m.list()).toHaveLength(1)
  })
})

describe('Stop, Close, the session, the helper, idleness', () => {
  it('Stop ends the running script at "stopped" and leaves the app running', STARTS_A_SCRIPT, async () => {
    const { m } = await rig({ connectCdp: vi.fn(() => new Promise<Cdp | null>(() => {})) })
    const run = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(FakeDesk.made[0]?.launches).toHaveLength(1), reachesHelper)
    expect(m.stop('s1')).toBe(true)
    expect(body(await run).error).toEqual({ message: 'stopped', at: 'stopped' })
    expect(FakeDesk.made[0].kills).toEqual([])
    expect(FakeDesk.made[0].closed).toBe(false)
    expect(m.stop('s1')).toBe(false)
  })

  it('the session ending mid launch stops the script and leaves nothing (Review Focus 4)', STARTS_A_SCRIPT, async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const { m, deps, events, settle } = await rig({ connectCdp: vi.fn(() => new Promise<Cdp | null>(() => {})) })
      const run = m.run('s1', "await launch({ command: 'app.exe' })")
      await vi.waitFor(() => expect(FakeDesk.made[0]?.launches).toHaveLength(1), reachesHelper)
      m.sessionEnded('s1')
      expect(body(await run).error?.at).toBe('stopped')
      await vi.waitFor(() => expect(FakeDesk.made[0].closed).toBe(true))
      expect(FakeDesk.made[0].kills).toEqual([501])
      expect(m.list()).toEqual([])
      await vi.waitFor(async () => expect(await fs.stat(deps.recordFile).then(() => true, () => false)).toBe(false))
      expect(events.at(-1)).toMatchObject({ kind: 'state', sessionId: 's1', open: false })
      await settle()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('a helper that dies takes its entry with it, the app tree is ended, and the next launch starts afresh', async () => {
    const { m, deps } = await rig({ startTimes: vi.fn(async () => new Map([[501, 3_000]])) })
    await m.run('s1', "await launch({ command: 'app.exe' })")
    FakeDesk.made[0].die('exited 1')
    await vi.waitFor(() => expect(deps.killTree).toHaveBeenCalledWith(501))
    expect(deps.startTimes).toHaveBeenCalledWith([501])
    expect(m.list()).toEqual([])
    await m.run('s1', "await launch({ command: 'app.exe' })")
    expect(FakeDesk.made).toHaveLength(2)
  })

  it('a helper that dies leaves a pid whose start time no longer matches alone (never a pid by number alone)', async () => {
    const { m, deps, settle } = await rig({ startTimes: vi.fn(async () => new Map([[501, 99_999]])) })
    await m.run('s1', "await launch({ command: 'app.exe' })")
    FakeDesk.made[0].die('exited 1')
    await vi.waitFor(() => expect(deps.startTimes).toHaveBeenCalledWith([501]))
    await settle()
    expect(deps.killTree).not.toHaveBeenCalled()
  })

  it('when the helper cannot end the app, the direct kill still checks the start time', async () => {
    const live = new Map<number, number>()
    const { m, deps } = await rig({ startTimes: vi.fn(async () => live) })
    await m.run('s1', "await launch({ command: 'a.exe' })")
    await m.run('s2', "await launch({ command: 'b.exe' })")
    FakeDesk.made[0].killFails = true
    FakeDesk.made[1].killFails = true
    live.set(501, 99_999)
    expect(await m.close('s1')).toBe(true)
    expect(deps.killTree).not.toHaveBeenCalled()
    live.set(511, 3_000)
    expect(await m.close('s2')).toBe(true)
    expect(deps.killTree).toHaveBeenCalledTimes(1)
    expect(deps.killTree).toHaveBeenCalledWith(511)
  })

  it('a Stop that lands before the desktop exists opens none (ruling F1)', STARTS_A_SCRIPT, async () => {
    let resolved!: () => void
    const { m, deps, settle } = await rig({
      resolveLaunch: ({ cwd }) =>
        new Promise((r) => {
          resolved = () => r({ command: 'app.exe', cwd, env: {} })
        })
    })
    const run = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(resolved).toBeTypeOf('function'), reachesHelper)
    expect(m.stop('s1')).toBe(true)
    expect(body(await run).error?.at).toBe('stopped')
    resolved()
    await settle()
    expect(deps.startDesk).not.toHaveBeenCalled()
    expect(m.list()).toEqual([])
  })

  it('a Stop that lands while the desktop is being created closes it and launches nothing (ruling F1)', STARTS_A_SCRIPT, async () => {
    let started!: () => void
    const { m, deps, events, settle } = await rig({
      startDesk: vi.fn(
        (name: string) =>
          new Promise<DesktopHelper>((r) => {
            started = () => r(new FakeDesk(name))
          })
      )
    })
    const run = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(started).toBeTypeOf('function'), reachesHelper)
    expect(m.stop('s1')).toBe(true)
    expect(body(await run).error?.at).toBe('stopped')
    started()
    await vi.waitFor(() => expect(FakeDesk.made[0]?.closed).toBe(true))
    await settle()
    expect(FakeDesk.made[0].launches).toEqual([])
    expect(m.list()).toEqual([])
    expect(events.at(-1)).toMatchObject({ kind: 'state', sessionId: 's1', open: false })
    await vi.waitFor(async () => expect(await fs.stat(deps.recordFile).then(() => true, () => false)).toBe(false))
  })

  it('the session ending while the desktop is being created closes it once and launches nothing (ruling F1)', STARTS_A_SCRIPT, async () => {
    let started!: () => void
    const { m, events, settle } = await rig({
      startDesk: vi.fn(
        (name: string) =>
          new Promise<DesktopHelper>((r) => {
            started = () => r(new FakeDesk(name))
          })
      )
    })
    const run = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(started).toBeTypeOf('function'), reachesHelper)
    m.sessionEnded('s1')
    expect(body(await run).error?.at).toBe('stopped')
    started()
    await vi.waitFor(() => expect(FakeDesk.made[0]?.closed).toBe(true))
    await settle()
    expect(FakeDesk.made[0].closes).toBe(1)
    expect(FakeDesk.made[0].launches).toEqual([])
    expect(m.list()).toEqual([])
    // Review minor 4: two cleanups racing over one desktop tell the app it closed once.
    expect(events.filter((e) => e.kind === 'state' && !e.open)).toHaveLength(1)
  })

  // Task 5 deferred minor: a Stop while the desktop starts leaves the app told `open: true` (run's
  // finally); a desktop that then fails to start must still be told closed, once, or the mirror shows a
  // workspace that no longer exists.
  const failingDesk = () => {
    let fail!: () => void
    const startDesk = vi.fn(
      () =>
        new Promise<DesktopHelper>((_r, reject) => {
          fail = () => reject(new Error('the helper would not start'))
        })
    )
    return { startDesk, fail: () => fail() }
  }
  const closedAfterLastOpen = (events: WorkspaceEvent[]) => {
    const states = events.filter((e) => e.kind === 'state')
    const lastOpen = states.map((e) => e.kind === 'state' && e.open).lastIndexOf(true)
    return states.slice(lastOpen + 1).filter((e) => e.kind === 'state' && !e.open)
  }

  it('Close after a Stop while the desktop starts, then the start fails, tells the app it closed once', STARTS_A_SCRIPT, async () => {
    const { startDesk, fail } = failingDesk()
    const { m, events, settle } = await rig({ startDesk })
    const run = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(startDesk).toHaveBeenCalled(), reachesHelper)
    expect(m.stop('s1')).toBe(true)
    expect(body(await run).error?.at).toBe('stopped')
    expect(events.at(-1)).toMatchObject({ kind: 'state', sessionId: 's1', open: true })
    const closing = m.close('s1')
    fail()
    expect(await closing).toBe(true)
    await settle()
    expect(closedAfterLastOpen(events)).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ kind: 'state', sessionId: 's1', open: false })
    expect(m.list()).toEqual([])
  })

  it('Close and the session ending at once, over a desktop that fails to start, tell the app it closed once', STARTS_A_SCRIPT, async () => {
    const { startDesk, fail } = failingDesk()
    const { m, events, settle } = await rig({ startDesk })
    const run = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(startDesk).toHaveBeenCalled(), reachesHelper)
    expect(m.stop('s1')).toBe(true)
    await run
    const closing = m.close('s1')
    m.sessionEnded('s1')
    fail()
    expect(await closing).toBe(true)
    await settle()
    expect(closedAfterLastOpen(events)).toHaveLength(1)
    expect(m.list()).toEqual([])
  })

  it('a desktop that fails to start after its script was stopped tells the app it closed, with no Close', STARTS_A_SCRIPT, async () => {
    const { startDesk, fail } = failingDesk()
    const { m, events, settle } = await rig({ startDesk })
    const run = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(startDesk).toHaveBeenCalled(), reachesHelper)
    expect(m.stop('s1')).toBe(true)
    await run
    fail()
    await settle()
    expect(closedAfterLastOpen(events)).toHaveLength(1)
    expect(m.list()).toEqual([])
    expect(await m.close('s1')).toBe(false)
  })

  it('Close and the session ending at once tell the app it closed once (review minor 4)', async () => {
    const { m, events, settle } = await rig()
    await m.run('s1', "await launch({ command: 'app.exe' })")
    const closing = m.close('s1')
    m.sessionEnded('s1')
    expect(await closing).toBe(true)
    await settle()
    expect(FakeDesk.made[0].closes).toBe(1)
    expect(events.filter((e) => e.kind === 'state' && !e.open)).toHaveLength(1)
  })

  // Final review Important 1: script 1's launch is stopped while it waits for the port; script 2
  // relaunches; script 1's wait then gives up. The connection script 2 made must survive for script 3.
  it('a stopped launch whose port wait ends after a newer relaunch leaves the newer connection in place', STARTS_A_SCRIPT, async () => {
    let giveUp!: (c: Cdp | null) => void
    const page = (): ReturnType<typeof fakeCdp> => {
      const c = fakeCdp()
      const send = c.send
      c.send = async (method: string) => (method === 'Runtime.evaluate' ? { result: { value: 'http://app/' } } : send(method))
      return c
    }
    const made: Array<ReturnType<typeof fakeCdp>> = []
    const connectCdp = vi.fn(async () => {
      if (connectCdp.mock.calls.length === 1) return new Promise<Cdp | null>((r) => (giveUp = r))
      const c = page()
      made.push(c)
      return c
    })
    const { m, settle } = await rig({ connectCdp })
    const first = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(giveUp).toBeTypeOf('function'), reachesHelper)
    expect(m.stop('s1')).toBe(true)
    expect(body(await first).error?.at).toBe('stopped')
    const second = await m.run('s1', 'await relaunch()')
    expect(body(second).error).toBeUndefined()
    giveUp(null)
    await settle()
    const third = await m.run('s1', 'log(await url())')
    expect(body(third).error).toBeUndefined()
    expect(body(third).log).toEqual(['http://app/'])
    expect(made).toHaveLength(1)
    expect(made[0].closed).toBe(false)
  })

  // Task 5 deferred minor: the normal path, an app launched by one script and used by the next.
  it('an app launched by one script is used by the next script, which can list its windows and relaunch it', async () => {
    const { m } = await rig()
    expect(body(await m.run('s1', "await launch({ command: 'app.exe' })")).error).toBeUndefined()
    const r = await m.run('s1', 'log((await windows()).length); log(await relaunch())')
    expect(body(r).error).toBeUndefined()
    expect(body(r).log).toEqual(['0', '{"pid":502,"port":9302}'])
    expect(FakeDesk.made).toHaveLength(1)
    expect(FakeDesk.made[0].kills).toEqual([501])
    expect(m.list()).toMatchObject([{ sessionId: 's1', running: false }])
  })

  it('a stale Stop does not close the desktop a newer script is starting on (review minor 3)', STARTS_A_SCRIPT, async () => {
    let started!: () => void
    const { m } = await rig({
      startDesk: vi.fn(
        (name: string) =>
          new Promise<DesktopHelper>((r) => {
            started = () => r(new FakeDesk(name))
          })
      )
    })
    const first = m.run('s1', "await launch({ command: 'a.exe' })")
    await vi.waitFor(() => expect(started).toBeTypeOf('function'), reachesHelper)
    expect(m.stop('s1')).toBe(true)
    expect(body(await first).error?.at).toBe('stopped')
    const second = m.run('s1', "log(await launch({ command: 'b.exe' }))")
    await new Promise((r) => setTimeout(r, 20))
    started()
    const r = await second
    expect(body(r).error).toBeUndefined()
    expect(FakeDesk.made).toHaveLength(1)
    expect(FakeDesk.made[0].closed).toBe(false)
    expect(FakeDesk.made[0].launches.map((l) => l.command)).toEqual(['b.exe'])
    expect(m.list()).toHaveLength(1)
  })

  it('a launch the script did not await opens nothing once the script has ended (review critical 1)', async () => {
    let resolved!: () => void
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const { m, deps, settle } = await rig({
        resolveLaunch: ({ cwd }) =>
          new Promise((r) => {
            resolved = () => r({ command: 'app.exe', cwd, env: {} })
          })
      })
      const r = await m.run('s1', "launch({ command: 'a.exe' }).catch(() => {}); log('done')")
      expect(body(r)).toEqual({ log: ['done'] })
      resolved()
      await settle()
      expect(deps.startDesk).not.toHaveBeenCalled()
      expect(m.list()).toEqual([])
      expect(await fs.stat(deps.recordFile).then(() => true, () => false)).toBe(false)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('an un-awaited launch that is quicker than the script end leaves nothing either (review critical 1)', async () => {
    const { m, deps, settle } = await rig()
    await m.run('s1', "launch({ command: 'a.exe' }).catch(() => {}); log('done')")
    await settle()
    await m.dispose()
    expect(FakeDesk.made.every((k) => k.closed)).toBe(true)
    const launched = FakeDesk.made.flatMap((k) => k.launches)
    if (launched.length > 0) expect(FakeDesk.made.flatMap((k) => k.kills)).toContain(501)
    await vi.waitFor(async () => expect(await fs.stat(deps.recordFile).then(() => true, () => false)).toBe(false))
  })

  // The script runs in a worker (scriptWorker.ts): a busy loop after an await is cut off at the
  // deadline, and this thread, which holds every session's terminal, keeps running meanwhile. The loop
  // is bounded so a manager that ran it on this thread fails here instead of hanging. Nothing times the
  // worker's start (shared CI runners): the outcome shows the loop was cut off rather than finished,
  // the ticks show this thread ran meanwhile, and the one bound left is far below the loop's own end.
  it('a busy loop after an await is cut off at the deadline without blocking the Host', { timeout: 40_000 }, async () => {
    const { m } = await rig({ scriptTimeoutMs: 3_000 })
    let ticks = 0
    const iv = setInterval(() => (ticks += 1), 20)
    const t0 = Date.now()
    try {
      const r = await m.run('s1', "await launch({ command: 'a.exe' }); { const end = Date.now() + 20000; while (Date.now() < end) {} } log('never')")
      expect(body(r).log).toEqual([])
      expect(body(r).error).toEqual({ at: 'timeout', message: expect.stringMatching(/^script did not finish within 3000 ms/) })
      expect(Date.now() - t0).toBeLessThan(10_000)
      expect(ticks).toBeGreaterThanOrEqual(3)
      expect(m.list()).toEqual([expect.objectContaining({ sessionId: 's1', running: false, helper: null })])
    } finally {
      clearInterval(iv)
    }
  })

  // Each script runs in a child process of its own: the session ending and the Host leaving both end it.
  for (const way of ['sessionEnded', 'dispose'] as const)
    it(`${way} ends a running script and its child process`, { timeout: 40_000 }, async () => {
      const { m } = await rig({ scriptTimeoutMs: 30_000 })
      const before = spawned.children.length
      const run = m.run('s1', "{ const end = Date.now() + 20000; while (Date.now() < end) {} } log('never')")
      await vi.waitFor(() => expect(spawned.children.length).toBe(before + 1), { timeout: 10_000 })
      const child = spawned.children[before]
      await new Promise((r) => setTimeout(r, 300))
      if (way === 'sessionEnded') m.sessionEnded('s1')
      else await m.dispose()
      expect(body(await run)).toEqual({ log: [], error: { message: 'stopped', at: 'stopped' } })
      await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true), { timeout: 10_000 })
    })

  it('a launch still on its way when the script times out opens nothing (review critical 1)', async () => {
    let resolved!: () => void
    // Longer than a child process takes to start (scriptWorker.ts), so the script reaches its launch;
    // the launch then waits for the test, so the deadline always comes first.
    const { m, deps, settle } = await rig({
      scriptTimeoutMs: 3_000,
      resolveLaunch: ({ cwd }) =>
        new Promise((r) => {
          resolved = () => r({ command: 'app.exe', cwd, env: {} })
        })
    })
    const r = await m.run('s1', "await launch({ command: 'a.exe' })")
    expect(body(r).error).toBeDefined()
    resolved()
    await settle()
    expect(deps.startDesk).not.toHaveBeenCalled()
    expect(m.list()).toEqual([])
  })

  for (const way of ['close', 'sessionEnded', 'dispose'] as const)
    it(`${way} while the app is starting ends the app once it has started (review important 2)`, STARTS_A_SCRIPT, async () => {
      let release!: () => void
      FakeDesk.hold = new Promise((r) => {
        release = r
      })
      const { m, deps, settle } = await rig({ startTimes: vi.fn(async () => new Map([[501, 3_000]])) })
      const run = m.run('s1', "await launch({ command: 'app.exe' })")
      await vi.waitFor(() => expect(FakeDesk.made[0]?.launches).toHaveLength(1), reachesHelper)
      if (way === 'close') expect(await m.close('s1')).toBe(true)
      else if (way === 'sessionEnded') m.sessionEnded('s1')
      else await m.dispose()
      await vi.waitFor(() => expect(FakeDesk.made[0].closed).toBe(true))
      release()
      expect(body(await run).error?.at).toBe('stopped')
      await vi.waitFor(() => expect(deps.killTree).toHaveBeenCalledWith(501))
      expect(deps.startTimes).toHaveBeenCalledWith([501])
      await settle()
      expect(m.list()).toEqual([])
      expect(await fs.stat(deps.recordFile).then(() => true, () => false)).toBe(false)
    })

  it('the session ending before the desktop exists opens none (ruling F1)', STARTS_A_SCRIPT, async () => {
    let resolved!: () => void
    const { m, deps, settle } = await rig({
      resolveLaunch: ({ cwd }) =>
        new Promise((r) => {
          resolved = () => r({ command: 'app.exe', cwd, env: {} })
        })
    })
    const run = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(resolved).toBeTypeOf('function'), reachesHelper)
    m.sessionEnded('s1')
    expect(body(await run).error?.at).toBe('stopped')
    resolved()
    await settle()
    expect(deps.startDesk).not.toHaveBeenCalled()
    expect(m.list()).toEqual([])
  })

  it('ten minutes without a script cleans the desktop up', async () => {
    const { m, tick } = await rig()
    await m.run('s1', "await launch({ command: 'app.exe' })")
    tick(30_000)
    expect(FakeDesk.made[0].closed).toBe(false)
    for (let i = 0; i < 20; i++) tick(30_000)
    await vi.waitFor(() => expect(FakeDesk.made[0].closed).toBe(true))
    expect(m.list()).toEqual([])
  })

  it('dispose cleans every desktop up and refuses what comes after', async () => {
    const { m } = await rig()
    await m.run('s1', "await launch({ command: 'a.exe' })")
    await m.run('s2', "await launch({ command: 'b.exe' })")
    await m.dispose()
    expect(FakeDesk.made.every((d) => d.closed)).toBe(true)
    expect((await m.run('s1', 'log(1)')).status).toBe(409)
  })
})

// Stage 4, task 2: a first dev build can take longer than a whole script may run. The wait for the
// app's port and page is a launch wait, which the script's deadline does not count (up to
// LAUNCH_WAIT_MAX_MS in all), so such an app can be launched at all. Scaled down: a 3 s deadline, long
// enough for the script's child to start on a shared CI runner, and a port that answers after 4.5 s.
describe('long launches', () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  it('a launch whose port answers after the deadline would have passed succeeds, with the waitMs the script asked for', { timeout: 40_000 }, async () => {
    const connectCdp = vi.fn(async () => {
      await sleep(4_500)
      return fakeCdp()
    })
    const { m } = await rig({ scriptTimeoutMs: 3_000, connectCdp })
    const r = await m.run('s1', "const a = await launch({ command: 'app.exe' }, { waitMs: 120000 }); log(a.pid)")
    expect(body(r)).toEqual({ log: ['501'] })
    expect(connectCdp).toHaveBeenCalledWith(expect.any(Number), 120_000)
  })

  it('the mirror hears how long the app has been starting, each second, and hears the end of it', { timeout: 40_000 }, async () => {
    let answer!: () => void
    const { m, events, tick } = await rig({ connectCdp: vi.fn(() => new Promise<Cdp | null>((r) => (answer = () => r(fakeCdp())))) })
    const run = m.run('s1', "await launch({ command: 'app.exe' }, { waitMs: 120000 })")
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'), { timeout: 15_000 })
    tick(FRAME_EVERY_MS)
    tick(FRAME_EVERY_MS)
    const launching = events.filter((e) => e.kind === 'state' && e.launching !== undefined)
    expect(launching.map((e) => e.kind === 'state' && e.launching)).toEqual(expect.arrayContaining([1, 2]))
    expect(launching.every((e) => e.kind === 'state' && e.open && e.running)).toBe(true)
    answer()
    expect(body(await run).error).toBeUndefined()
    const last = events.filter((e) => e.kind === 'state').at(-1)
    expect(last).toMatchObject({ kind: 'state', sessionId: 's1', open: true, running: false })
    expect(last).not.toHaveProperty('launching')
    expect(m.list()).toEqual([expect.objectContaining({ sessionId: 's1', running: false, helper: null })])
  })

  // Review follow-up: a launch the script left behind when it timed out (held here until after the
  // timeout, in desk.launch) reaches its port wait with the run already over. It must not wait there.
  it('a launch left behind by a timeout does not wait for the port at all', { timeout: 40_000 }, async () => {
    let release!: () => void
    FakeDesk.hold = new Promise((r) => {
      release = r
    })
    const connectCdp = vi.fn(async () => fakeCdp())
    const { m, settle } = await rig({ scriptTimeoutMs: 3_000, connectCdp })
    const r = await m.run('s1', "await launch({ command: 'app.exe' }, { waitMs: 300000 })")
    expect(body(r).error?.at).toBe('timeout')
    release()
    await vi.waitFor(() => expect(FakeDesk.made[0]?.launches).toHaveLength(1))
    await settle()
    expect(connectCdp).not.toHaveBeenCalled()
  })

  it('Stop during a long launch ends the script at once, well past where the deadline would have been', { timeout: 40_000 }, async () => {
    let waiting = false
    const { m } = await rig({
      scriptTimeoutMs: 1_000,
      connectCdp: vi.fn(() => {
        waiting = true
        return new Promise<Cdp | null>(() => {})
      })
    })
    let settled = false
    const run = m.run('s1', "await launch({ command: 'app.exe' }, { waitMs: 300000 })")
    void run.then(() => (settled = true))
    await vi.waitFor(() => expect(waiting).toBe(true), { timeout: 15_000 })
    await sleep(1_500)
    expect(settled).toBe(false)
    const t0 = Date.now()
    expect(m.stop('s1')).toBe(true)
    expect(body(await run).error).toEqual({ message: 'stopped', at: 'stopped' })
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(FakeDesk.made[0].closed).toBe(false)
  })
})

describe('frames', () => {
  it('a helper that changes the screen sends a scaled JPEG frame while an app watches', async () => {
    const { m, events } = await rig()
    await m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'frame')).toBe(true))
    const f = events.find((e) => e.kind === 'frame') as Extract<WorkspaceEvent, { kind: 'frame' }>
    expect(f.frame).toMatchObject({ jpeg: '/9j/frame', width: 960, height: 540 })
    expect(m.list()[0].frame?.jpeg).toBe('/9j/frame')
  })

  it('the frame timer keeps running after close() inside the script, for the next launch (ruling F6)', STARTS_A_SCRIPT, async () => {
    let second!: () => void
    let calls = 0
    const { m, events, tick } = await rig({
      connectCdp: vi.fn(() => {
        calls += 1
        if (calls === 1) return Promise.resolve<Cdp | null>(fakeCdp())
        return new Promise<Cdp | null>((r) => {
          second = () => r(null)
        })
      })
    })
    const run = m.run('s1', "await launch({ command: 'a.exe' }); await close(); await launch({ command: 'a.exe' })")
    await vi.waitFor(() => expect(second).toBeTypeOf('function'), reachesHelper)
    await new Promise((r) => setTimeout(r, 20))
    events.length = 0
    tick(1_000)
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'frame' && e.frame.jpeg === '/9j/')).toBe(true))
    second()
    await run
  })

  it('captures nothing while no app watches', async () => {
    const cdp = fakeCdp()
    const { m } = await rig({ hasWatchers: () => false, connectCdp: vi.fn(async () => cdp) })
    await m.run('s1', "await launch({ command: 'app.exe' })")
    await new Promise((r) => setTimeout(r, 20))
    expect(cdp.calls).not.toContain('Page.captureScreenshot')
  })
})

describe('sweepLeftovers', () => {
  it('kills only the recorded pids whose start time still matches, then removes the file', async () => {
    const { m, deps } = await rig({ startTimes: vi.fn(async () => new Map([[501, 3_000], [9000, 99_999]])) })
    await fs.mkdir(path.dirname(deps.recordFile), { recursive: true })
    await fs.writeFile(
      deps.recordFile,
      JSON.stringify({ version: 1, workspaces: [{ sessionId: 's1', desktop: 'd', pids: [{ pid: 501, startedAt: 3_000 }, { pid: 9000, startedAt: 2_000 }] }] }),
      'utf8'
    )
    await m.sweepLeftovers()
    expect(deps.killTree).toHaveBeenCalledTimes(1)
    expect(deps.killTree).toHaveBeenCalledWith(501)
    expect(await fs.stat(deps.recordFile).then(() => true, () => false)).toBe(false)
  })

  it('a malformed file kills nothing and is removed; no file is nothing to do', async () => {
    const { m, deps } = await rig()
    await m.sweepLeftovers()
    await fs.mkdir(path.dirname(deps.recordFile), { recursive: true })
    await fs.writeFile(deps.recordFile, '{ nope', 'utf8')
    await m.sweepLeftovers()
    expect(deps.killTree).not.toHaveBeenCalled()
    expect(await fs.stat(deps.recordFile).then(() => true, () => false)).toBe(false)
  })

  it('a launch waits for the sweep, so the sweep never removes a new record', async () => {
    let release!: () => void
    const { m, deps, file } = await rig({ startTimes: vi.fn(() => new Promise<Map<number, number>>((r) => { release = () => r(new Map()) })) })
    await fs.mkdir(path.dirname(deps.recordFile), { recursive: true })
    await fs.writeFile(deps.recordFile, JSON.stringify({ version: 1, workspaces: [{ sessionId: 'old', desktop: 'd', pids: [{ pid: 1, startedAt: 1 }] }] }), 'utf8')
    const sweep = m.sweepLeftovers()
    const run = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await sweep
    await run
    await vi.waitFor(async () => expect(((await file()) as { workspaces: Array<{ sessionId: string }> }).workspaces.map((w) => w.sessionId)).toEqual(['s1']))
  })
})

// Final review Important 2: the Host's way out waits for the workspaces no longer than a cap, then goes
// on; the next Host's leftover sweep ends whatever a capped dispose left behind.
describe('disposeWithin (the Host leaving)', () => {
  it('returns when the dispose finishes, and says nothing', async () => {
    const onCap = vi.fn()
    await disposeWithin(Promise.resolve(), 50, onCap)
    await new Promise((r) => setTimeout(r, 80))
    expect(onCap).not.toHaveBeenCalled()
  })

  it('returns at the cap when the dispose hangs, and says the cap fired', async () => {
    vi.useFakeTimers()
    try {
      const onCap = vi.fn()
      let done = false
      const p = disposeWithin(new Promise<void>(() => {}), DISPOSE_CAP_MS, onCap).then(() => (done = true))
      await vi.advanceTimersByTimeAsync(DISPOSE_CAP_MS - 1)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(done).toBe(true)
      expect(onCap).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the cap is 10 s', () => {
    expect(DISPOSE_CAP_MS).toBe(10_000)
  })

  // index.ts starts the Host when imported, so its leave() cannot run under a test; this pins the
  // wiring the way driving.integration.test.ts pins the rest of leave().
  it('index.ts leave() waits for the workspaces through disposeWithin, before the spawn settle', () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8')
    const leave = src.slice(src.indexOf('const leave = '))
    const at = leave.indexOf('await disposeWithin(')
    expect(at).toBeGreaterThan(-1)
    expect(leave.slice(at, leave.indexOf('spawner.closeAndSettle'))).toMatch(/workspaces\.dispose\(\)[\s\S]*DISPOSE_CAP_MS/)
    expect(at).toBeLessThan(leave.indexOf('spawner.closeAndSettle'))
    expect(leave).not.toMatch(/await workspaces\.dispose\(\)/)
  })
})

describe('the app size (the mirror tab fills with the app)', () => {
  const overrides = (cdp: ReturnType<typeof fakeCdp>) => cdp.sent.filter((x) => x.method === 'Emulation.setDeviceMetricsOverride').map((x) => x.params)
  const at = (size: { width: number; height: number }) => ({ ...size, deviceScaleFactor: 0, mobile: false })

  it('on Windows a launch lays the page out at the default size when no mirror tab has said how big it is, and leaves the window alone', async () => {
    const cdp = fakeCdp()
    const { m } = await rig({ connectCdp: vi.fn(async () => cdp) })
    await m.run('s1', "await launch({ command: 'app.exe' })")
    expect(overrides(cdp)).toEqual([at(DEFAULT_APP_SIZE)])
    expect(FakeDesk.made[0].fits).toEqual([])
  })

  it('a launch takes the mirror tab size, in CSS pixels whatever the page devicePixelRatio', async () => {
    const cdp = fakeCdp({ dpr: 1.5 })
    const { m } = await rig({ connectCdp: vi.fn(async () => cdp) })
    expect(m.resize('s1', { width: 1000.4, height: 600 })).toBe(true)
    await m.run('s1', "await launch({ command: 'app.exe' })")
    expect(overrides(cdp)).toEqual([at({ width: 1000, height: 600 })])
  })

  it('a resized mirror tab resizes the running app, once per size; null forgets the size', async () => {
    const cdp = fakeCdp()
    const { m, settle } = await rig({ connectCdp: vi.fn(async () => cdp) })
    await m.run('s1', "await launch({ command: 'app.exe' })")
    expect(m.resize('s1', { width: 1400, height: 900 })).toBe(true)
    expect(m.resize('s1', { width: 1400, height: 900 })).toBe(true)
    await settle()
    expect(overrides(cdp)).toEqual([at(DEFAULT_APP_SIZE), at({ width: 1400, height: 900 })])
    expect(m.resize('s1', { width: 0, height: 0 })).toBe(false)
    expect(m.resize('s1', null)).toBe(true)
    await settle()
    expect(overrides(cdp)).toHaveLength(2)
  })

  it('an override the page does not keep is set again (measured on the hidden desktop: undone about 300 ms after launch)', async () => {
    const reads: Array<[number, number]> = [[1200, 750], [1200, 750], [3840, 2028]]
    const cdp = fakeCdp({ pageReads: reads, pageAfter: [1200, 750] })
    const { m, deps } = await rig({ connectCdp: vi.fn(async () => cdp), log: vi.fn() })
    m.resize('s1', { width: 1200, height: 750 })
    await m.run('s1', "await launch({ command: 'app.exe' })")
    expect(overrides(cdp)).toEqual([at({ width: 1200, height: 750 }), at({ width: 1200, height: 750 })])
    expect(vi.mocked(deps.log).mock.calls.map((c) => c[0]).join(' | ')).toContain('the page lays out at that size (set 2 times)')
  }, 20_000)

  it('a frame whose page is another size than it was given sizes it again, a few times at most', STARTS_A_SCRIPT, async () => {
    // The page measured on the hidden desktop: maximized by the app itself to 3840x2088.
    const cdp = fakeCdp({ viewport: { width: 3840, height: 2088 } })
    const { m, tick, settle } = await rig({ connectCdp: vi.fn(async () => cdp) })
    const run = m.run('s1', "await launch({ command: 'app.exe' }); await waitFor(1500)")
    await vi.waitFor(() => expect(overrides(cdp)).toHaveLength(1), reachesHelper)
    tick(FRAME_EVERY_MS)
    await settle()
    expect(overrides(cdp)).toHaveLength(1)
    for (let i = 0; i < (REFIT_TRIES + 2) * (REFIT_AFTER_MS / FRAME_EVERY_MS); i++) {
      tick(FRAME_EVERY_MS)
      await settle()
    }
    expect(overrides(cdp)).toHaveLength(REFIT_TRIES)
    // A page that took the size asks for nothing more.
    cdp.viewport = { width: 1200, height: 700 }
    m.resize('s1', { width: 1200, height: 700 })
    await settle()
    for (let i = 0; i < 2 * (REFIT_AFTER_MS / FRAME_EVERY_MS); i++) {
      tick(FRAME_EVERY_MS)
      await settle()
    }
    expect(overrides(cdp)).toHaveLength(REFIT_TRIES + 1)
    expect(overrides(cdp).at(-1)).toEqual(at({ width: 1200, height: 700 }))
    expect(body(await run).error).toBeUndefined()
  })

  it('on Linux the window is sized, in the page device pixels, and the page is not overridden; on macOS only the page', async () => {
    const linuxCdp = fakeCdp({ dpr: 1.5 })
    const { m: linux } = await rig({ platform: 'linux', linuxTools: async () => ({ missing: [], installLine: '' }), connectCdp: vi.fn(async () => linuxCdp) })
    linux.resize('s1', { width: 1000, height: 600 })
    await linux.run('s1', "await launch({ command: 'app' })")
    expect(FakeDesk.made[0].fits).toEqual([{ width: 1500, height: 900 }])
    expect(overrides(linuxCdp)).toEqual([])
    const macCdp = fakeCdp()
    const { m: mac } = await rig({
      platform: 'darwin',
      connectCdp: vi.fn(async () => macCdp),
      startDesk: vi.fn(async (name: string) => Object.assign(new FakeDesk(name), { fit: undefined }))
    })
    await mac.run('s1', "await launch({ command: 'app' })")
    expect(overrides(macCdp)).toEqual([at(DEFAULT_APP_SIZE)])
  })

  it('the frame is the page viewport, scaled down only to the frame width', async () => {
    const cdp = fakeCdp({ viewport: { width: 1578, height: 989 } })
    const { m, events } = await rig({ connectCdp: vi.fn(async () => cdp) })
    await m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'frame')).toBe(true))
    const shot = cdp.sent.find((x) => x.method === 'Page.captureScreenshot')!
    expect(shot.params).toMatchObject({ format: 'jpeg', clip: { x: 0, y: 0, width: 1578, height: 989, scale: 960 / 1578 } })
    const f = events.find((e) => e.kind === 'frame') as Extract<WorkspaceEvent, { kind: 'frame' }>
    expect(f.frame).toMatchObject({ width: 960, height: 602 })
  })
})
