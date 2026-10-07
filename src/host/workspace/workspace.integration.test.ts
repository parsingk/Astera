// `app js` through a real Host with no app attached, and the mirror events at the IPC level (spec,
// Testing, Integration). A real startHostServer on a temp profile's own address and a real
// createHostOrch; the WorkspaceManager is the real one over a fake desktop and a fake CDP, because
// the real ones need Windows (Task 10).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostAddress } from '../address'
import { encodeLine, createLineReader } from '../framing'
import { startHostServer, type HostServer } from '../server'
import { createHostOrch } from '../orch'
import { hostFeatures } from '../features'
import { HOST_FEATURE_WORKSPACE, HOST_PROTOCOL, HOST_YIELD_WORKSPACE, type HostMessage } from '../../core/host/protocol'
import type { Cdp } from '../../core/workspace/helpers'
import type { DesktopHelper } from './desktopHelper'
import { createWorkspaceManager } from './manager'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

const fakeDesk = (name: string): DesktopHelper => ({
  name,
  pid: 4000,
  startedAt: 1,
  alive: () => true,
  onExit: () => {},
  launch: async () => ({ pid: 4001, startedAt: 2 }),
  kill: async () => {},
  windows: async () => [],
  shot: async () => ({ data: '/9j/', width: 1, height: 1, title: 'T' }),
  keys: async () => {},
  close: async () => {}
})

const fakeCdp = (): Cdp => ({
  send: async (method) => (method === 'Page.captureScreenshot' ? { data: '/9j/page' } : method === 'Page.getLayoutMetrics' ? { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } } : {}),
  waitEvent: async () => ({}),
  consoleErrors: () => [],
  close: () => {}
})

/** One socket, its greeting, and every message the Host sends it afterwards. */
const client = async (address: string, hello: Record<string, unknown>) => {
  const sock = net.connect(address)
  await new Promise((r) => sock.once('connect', r))
  const got: HostMessage[] = []
  const read = createLineReader({ onMessage: (v) => got.push(v as HostMessage), onBadLine: () => {}, onHandlerError: () => {} })
  sock.setEncoding('utf8')
  sock.on('data', (c: string) => read(c))
  sock.write(encodeLine({ t: 'hello', protocol: HOST_PROTOCOL, app: '9.9.9', ...hello }))
  await vi.waitFor(() => expect(got.some((m) => m.t === 'hello')).toBe(true))
  cleanups.push(() => void sock.destroy())
  let call = 0
  const orchCall = async (cmd: string, args: Record<string, unknown>, session = '', request?: string) => {
    const id = `c${++call}`
    sock.write(encodeLine({ t: 'orch-call', call: id, cmd, args, session, ...(request ? { request } : {}) }))
    await vi.waitFor(() => expect(got.some((m) => m.t === 'orch-result' && m.call === id)).toBe(true), { timeout: 10_000 })
    return got.find((m) => m.t === 'orch-result' && m.call === id) as Extract<HostMessage, { t: 'orch-result' }>
  }
  return { got, orchCall }
}

const host = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-ws 통합-'))
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const profileDir = path.join(dir, 'profile')
  await fs.mkdir(profileDir, { recursive: true })
  let server!: HostServer
  const workspaces = createWorkspaceManager({
    platform: 'win32',
    env: {},
    recordFile: path.join(profileDir, 'orch', 'workspaces.json'),
    shotsDir: path.join(profileDir, 'preview', 'shots'),
    enabled: async () => true,
    guide: () => '',
    sessionCwd: async (id) => (id === 's1' ? dir : null),
    resolveLaunch: async ({ cwd }) => ({ command: 'app.exe', cwd, env: {} }),
    startDesk: async (name) => fakeDesk(name),
    connectCdp: async () => fakeCdp(),
    freePort: async () => 9555,
    killTree: async () => {},
    startTimes: async () => new Map(),
    emit: (event) => server.broadcast({ t: 'workspace', event }, (y) => y.has(HOST_YIELD_WORKSPACE)),
    hasWatchers: () => server.appsYield(HOST_YIELD_WORKSPACE),
    log: () => {}
  })
  cleanups.push(() => workspaces.dispose())
  const orch = createHostOrch({
    profileDir,
    version: '9.9.9',
    now: () => new Date().toISOString(),
    hostStartedAt: () => server.startedAt,
    runningSessions: () => 0,
    aliveSessionIds: () => new Set<string>(),
    act: async () => ({}),
    hasApp: () => server.hasApp(),
    onState: () => {},
    log: () => {},
    sessions: { listSessions: async () => [], readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }), sendSession: async () => {}, readChat: async () => [], sendChat: async () => {}, serial: (_id, run) => run() },
    workspaces
  })
  const addr = hostAddress({ profileDir, platform: process.platform, tmpDir: dir, protocol: HOST_PROTOCOL })
  server = await startHostServer({
    address: addr.address,
    dirToPrepare: addr.dirToPrepare,
    version: '9.9.9',
    idleMs: 60_000,
    onIdle: () => {},
    orch,
    features: hostFeatures({ spawns: false, workspace: true }),
    pidLives: () => true,
    log: { write: () => {}, close: () => {} }
  })
  cleanups.push(() => server.close())
  return { address: addr.address }
}

describe('app js through a Host with no app attached', () => {
  it('runs from a CLI socket, and the Host announces workspace', async () => {
    const h = await host()
    const cli = await client(h.address, { role: 'cli' })
    const hello = cli.got.find((m) => m.t === 'hello') as Extract<HostMessage, { t: 'hello' }>
    expect(hello.features).toContain(HOST_FEATURE_WORKSPACE)
    const r = await cli.orchCall('app-js', { script: "log(await launch({ command: 'app.exe' }))" }, 's1', 'req-1')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ log: ['{"pid":4001,"port":9555}'] })
  })
})

describe('the mirror events at the IPC level', () => {
  it('reach an app that yields workspace, and never one that does not', async () => {
    const h = await host()
    const watcher = await client(h.address, { role: 'app', yields: [HOST_YIELD_WORKSPACE] })
    const older = await client(h.address, { role: 'app', yields: ['worktrees'] })
    const cli = await client(h.address, { role: 'cli' })
    await cli.orchCall('app-js', { script: "await launch({ command: 'app.exe' })" }, 's1')
    await vi.waitFor(() => {
      const events = watcher.got.filter((m): m is Extract<HostMessage, { t: 'workspace' }> => m.t === 'workspace').map((m) => m.event)
      expect(events.some((e) => e.kind === 'state' && e.sessionId === 's1' && e.open)).toBe(true)
      expect(events.some((e) => e.kind === 'frame' && e.frame.jpeg === '/9j/page')).toBe(true)
    })
    expect(older.got.some((m) => m.t === 'workspace')).toBe(false)
    expect(cli.got.some((m) => m.t === 'workspace')).toBe(false)

    const listed = await watcher.orchCall('workspace-list', {})
    expect(listed.body).toMatchObject({ workspaces: [{ sessionId: 's1', running: false }] })
    const closed = await watcher.orchCall('workspace-close', { sessionId: 's1' })
    expect(closed.body).toEqual({ closed: true })
    await vi.waitFor(() =>
      expect(watcher.got.some((m) => m.t === 'workspace' && m.event.kind === 'state' && m.event.open === false)).toBe(true)
    )
    expect((await cli.orchCall('workspace-list', {})).status).toBe(403)
  })
})

// The Host entry point starts a process and cannot run here, so its wiring is pinned by text. Each
// line names the mutation that makes it fail.
describe('src/host/index.ts wiring (source guard)', () => {
  const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  /** The text of the `createHostOrch({ ... })` argument (preflight ruling F10): a `workspaces,` line
   *  anywhere else in the file must not pass for the orch being given the manager. */
  const orchCallArgument = (): string => {
    const open = src.indexOf('createHostOrch({')
    if (open < 0) return ''
    let depth = 0
    for (let i = open + 'createHostOrch('.length; i < src.length; i++) {
      if (src[i] === '{') depth += 1
      else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
    }
    return ''
  }
  it('builds the manager, hands it to the orch, and announces the feature on every platform the workspace runs on', () => {
    expect(src).toMatch(/createWorkspaceManager\(/) // the manager is never built
    expect(orchCallArgument()).toMatch(/^\s*workspaces(: workspaces)?,?\s*$/m) // createHostOrch is not given it
    expect(src).toMatch(/workspace:\s*workspaceSupported\(process\.platform\)/) // announced on one platform only, or everywhere
    expect(src).not.toMatch(/workspace:\s*process\.platform === 'win32'/) // the Windows only gate came back
  })
  it("starts each platform's desk through one starter, and checks the Linux tools on every app js", () => {
    expect(src).toMatch(/startDesk:\s*workspaceDeskStarter\(\{\s*platform:\s*process\.platform/) // the PowerShell helper on every OS
    expect(src).toMatch(/linuxTools:\s*\(\)\s*=>\s*probeLinuxTools\(realProbeDeps\(process\.env\)\)/) // the L1 refusal never fires
  })
  it('pushes only to apps that yield workspace, and captures only for them', () => {
    expect(src).toMatch(/y\.has\(HOST_YIELD_WORKSPACE\)/)
    expect(src).toMatch(/appsYield\(HOST_YIELD_WORKSPACE\)/)
  })
  it('sweeps leftovers at start, disposes on leave, and ends a workspace with its session', () => {
    expect(src).toMatch(/workspaces\.sweepLeftovers\(\)/)
    expect(src).toMatch(/workspaces\.dispose\(\)/)
    expect(src).toMatch(/workspaces\.sessionEnded\(/)
  })
})
