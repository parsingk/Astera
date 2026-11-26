import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import type { LanguageServerSettings, LspFileDiagnostics, LspProblem, LspServerId, LspServerStatus } from '../../core/lsp/model'
import { languageServersOf } from '../../core/settings/languageServers'
import { createLspManager } from './manager'
import type { LspLaunch, LspRefused, LspSession, startLspSession } from './session'

// Phase 3 Part 3: the Host's language servers, one per root and language, against fake sessions (no processes)
const A = path.resolve('rootA')
const at = (root: string, name: string): string => path.join(root, name)

interface Fake {
  launch: LspLaunch
  opens: Array<[string, string]>
  closes: string[]
  changes: Array<[string, string]>
  shutdowns: number
  cb: Parameters<typeof startLspSession>[1]
}

function rig(o: {
  files?: Record<string, string>
  sizes?: Record<string, number>
  installed?: LspServerId[]
  settings?: LanguageServerSettings
  refuse?: (server: LspServerId) => LspRefused | null
  timings?: Parameters<typeof createLspManager>[0]['timings']
  settingsFail?: boolean
  launchFile?: () => string
  readDelay?: () => Promise<void>
  now?: () => number
} = {}) {
  const files: Record<string, string> = { ...(o.files ?? {}) }
  const sessions: Fake[] = []
  const emitted: LspFileDiagnostics[][] = []
  const states: LspServerStatus[][] = []
  const pythonPaths: Array<string | undefined> = []
  const m = createLspManager({
    profileDir: path.resolve('prof'),
    exec: 'electron',
    env: {},
    installer: { installed: async (id) => (o.installed ?? ['typescript', 'typescript5', 'python']).includes(id) },
    settings: async () => {
      if (o.settingsFail) throw new Error('app-settings.json could not be read')
      return o.settings ?? languageServersOf(undefined)
    },
    emit: (f) => emitted.push(f),
    state: (s) => states.push(s),
    log: () => {},
    launch: (d) => {
      pythonPaths.push(d.pythonPath?.pythonPath)
      const refused = o.refuse?.(d.server) ?? null
      return refused ?? { server: d.server, root: d.root, file: o.launchFile?.() ?? 'x', args: [], env: {}, log: 'l' }
    },
    start: (launch, cb) => {
      const f: Fake = { launch, opens: [], closes: [], changes: [], shutdowns: 0, cb }
      sessions.push(f)
      const s: LspSession = {
        pid: 100 + sessions.length,
        open: (p, text) => f.opens.push([p, text]),
        changed: (p, kind) => f.changes.push([p, kind]),
        close: (p) => {
          f.closes.push(p)
          cb.onDiagnostics(p, [])
        },
        shutdown: async () => {
          f.shutdowns++
          cb.onExit({ crashed: false, reason: 'stopped' })
        }
      }
      return s
    },
    readFile: async (p) => {
      await o.readDelay?.()
      const text = files[p]
      if (text === undefined) throw new Error(`ENOENT ${p}`)
      return Buffer.from(text, 'utf8')
    },
    stat: async (p) => (files[p] === undefined ? null : { size: o.sizes?.[p] ?? files[p].length }),
    exists: () => true,
    ...(o.now ? { now: o.now } : {}),
    timings: { idleMs: 60_000, backoffMs: [10, 10], stableMs: 10_000, failAfter: 3, maxServers: 4, ...o.timings }
  })
  const last = (p: string): LspProblem[] | undefined => emitted.flat().filter((f) => f.path === p).at(-1)?.problems
  const live = (): Fake[] => sessions.filter((s) => s.shutdowns === 0)
  return { m, sessions, emitted, states, files, last, live, pythonPaths }
}

const problem: LspProblem = { line: 1, column: 1, endLine: 1, endColumn: 2, severity: 'error', message: 'x' }

describe('createLspManager', () => {
  it('starts one server per root and language when a file opens, and stops it after the idle wait', async () => {
    const r = rig({ files: { [at(A, 'a.ts')]: 'a', [at(A, 'b.tsx')]: 'b', [at(A, 'c.py')]: 'c' }, timings: { idleMs: 50 } })
    r.m.sync([{ path: at(A, 'a.ts'), root: A }, { path: at(A, 'b.tsx'), root: A }, { path: at(A, 'c.py'), root: A }, { path: at(A, 'notes.md'), root: A }], {})
    await r.m.settled()
    expect(r.sessions.map((s) => s.launch.server).sort()).toEqual(['python', 'typescript'])
    const ts = r.sessions.find((s) => s.launch.server === 'typescript')!
    expect(ts.opens.map(([p]) => p).sort()).toEqual([at(A, 'a.ts'), at(A, 'b.tsx')])
    ts.cb.onReady()
    expect(r.m.status().find((s) => s.server === 'typescript')).toMatchObject({ root: A, status: 'running', pid: expect.any(Number) })
    r.m.sync([], {})
    await r.m.settled()
    expect(r.live()).toHaveLength(2)
    await vi.waitFor(() => expect(r.live()).toHaveLength(0))
    expect(r.m.status()).toEqual([])
  })

  // Final review M3: a pull that did not answer twice is said on the server's status, not only in its log
  it('shows on the server status what the session said went wrong, until it is ready again', async () => {
    const r = rig({ files: { [at(A, 'a.ts')]: 'a' } })
    r.m.sync([{ path: at(A, 'a.ts'), root: A }], {})
    await r.m.settled()
    const s = r.sessions[0]
    s.cb.onReady()
    const before = r.states.length
    s.cb.onTrouble?.('a pull of a.ts did not answer: timeout')
    expect(r.m.status()[0]).toMatchObject({ status: 'running', reason: 'a pull of a.ts did not answer: timeout' })
    await vi.waitFor(() => expect(r.states.length).toBeGreaterThan(before))
    expect(r.states.at(-1)?.[0]?.reason).toBe('a pull of a.ts did not answer: timeout')
  })

  it('closes what left the open set and clears its problems', async () => {
    const r = rig({ files: { [at(A, 'a.ts')]: 'a', [at(A, 'b.ts')]: 'b' } })
    r.m.sync([{ path: at(A, 'a.ts'), root: A }, { path: at(A, 'b.ts'), root: A }], {})
    await r.m.settled()
    const s = r.sessions[0]
    s.cb.onDiagnostics(at(A, 'a.ts'), [problem])
    await vi.waitFor(() => expect(r.last(at(A, 'a.ts'))).toEqual([problem]))
    expect(r.emitted.flat().find((f) => f.path === at(A, 'a.ts'))).toMatchObject({ root: A, server: 'typescript', producedAt: expect.any(String) })
    r.m.sync([{ path: at(A, 'b.ts'), root: A }], {})
    await r.m.settled()
    expect(s.closes).toEqual([at(A, 'a.ts')])
    await vi.waitFor(() => expect(r.last(at(A, 'a.ts'))).toEqual([]))
    await r.m.stopAll()
  })

  it('reopens a saved file only when its content changed', async () => {
    const r = rig({ files: { [at(A, 'a.ts')]: 'one' } })
    r.m.sync([{ path: at(A, 'a.ts'), root: A }], {})
    await r.m.settled()
    const s = r.sessions[0]
    r.m.saved([at(A, 'a.ts'), at(A, 'never-open.ts')])
    await r.m.settled()
    expect(s.opens).toEqual([[at(A, 'a.ts'), 'one']])
    r.files[at(A, 'a.ts')] = 'two'
    r.m.saved([at(A, 'a.ts')])
    await r.m.settled()
    expect(s.opens).toEqual([[at(A, 'a.ts'), 'one'], [at(A, 'a.ts'), 'two']])
    await r.m.stopAll()
  })

  it('never runs more than four servers: the least recently used one stops for a fifth', async () => {
    const roots = ['r1', 'r2', 'r3', 'r4', 'r5'].map((n) => path.resolve(n))
    const files = Object.fromEntries(roots.map((root) => [at(root, 'a.ts'), 'x']))
    const r = rig({ files })
    const open = roots.map((root) => ({ path: at(root, 'a.ts'), root }))
    for (let i = 1; i <= 5; i++) {
      r.m.sync(open.slice(0, i), {})
      await r.m.settled()
      expect(r.live().length).toBeLessThanOrEqual(4)
    }
    expect(r.sessions).toHaveLength(5)
    expect(r.sessions[0].shutdowns).toBe(1)
    expect(r.m.status().find((s) => s.root === roots[0])).toMatchObject({ status: 'stopped', why: 'room' })
    await r.m.stopAll()
  })

  it('does not open a file over 2 MiB, nor one outside its root, nor one of a language turned off', async () => {
    const big = at(A, 'big.ts')
    const r = rig({
      files: { [big]: 'x', [path.resolve('elsewhere', 'b.ts')]: 'y', [at(A, 'c.py')]: 'z' },
      sizes: { [big]: 3 * 1024 * 1024 },
      settings: languageServersOf({ python: { enabled: false } })
    })
    r.m.sync([{ path: big, root: A }, { path: path.resolve('elsewhere', 'b.ts'), root: A }, { path: at(A, 'c.py'), root: A }], {})
    await r.m.settled()
    expect(r.sessions.flatMap((s) => s.opens)).toEqual([])
    expect(r.sessions.some((s) => s.launch.server === 'python')).toBe(false)
    await r.m.stopAll()
  })

  it('says a server is not installed when its launch is refused for a missing file', async () => {
    const r = rig({ files: { [at(A, 'a.py')]: 'x' }, refuse: (s) => (s === 'python' ? { refused: 'not installed: x is missing', why: 'not-installed' } : null) })
    r.m.sync([{ path: at(A, 'a.py'), root: A }], {})
    await r.m.settled()
    expect(r.sessions).toEqual([])
    expect(r.m.status()).toEqual([expect.objectContaining({ server: 'python', root: A, status: 'stopped', why: 'not-installed', reason: 'not installed: x is missing' })])
  })

  it('restarts a crashed server with its documents and marks it failed after three crashes', async () => {
    const r = rig({ files: { [at(A, 'a.ts')]: 'a' } })
    r.m.sync([{ path: at(A, 'a.ts'), root: A }], {})
    await r.m.settled()
    r.sessions[0].cb.onDiagnostics(at(A, 'a.ts'), [problem])
    r.sessions[0].cb.onExit({ crashed: true, reason: 'it exited on its own (code 3)' })
    await vi.waitFor(() => expect(r.sessions).toHaveLength(2))
    await r.m.settled()
    expect(r.sessions[1].opens).toEqual([[at(A, 'a.ts'), 'a']])
    expect(r.last(at(A, 'a.ts'))).toEqual([])
    r.sessions[1].cb.onExit({ crashed: true, reason: 'again' })
    await vi.waitFor(() => expect(r.sessions).toHaveLength(3))
    r.sessions[2].cb.onExit({ crashed: true, reason: 'third' })
    await new Promise((res) => setTimeout(res, 50))
    expect(r.sessions).toHaveLength(3)
    expect(r.m.status()).toEqual([expect.objectContaining({ status: 'failed', why: 'crashed', reason: 'third' })])
  })

  it('restarts the python server when its interpreter changes', async () => {
    const py1 = path.resolve('py1', 'python.exe')
    const py2 = path.resolve('py2', 'python.exe')
    const r = rig({ files: { [at(A, 'a.py')]: 'a' } })
    r.m.sync([{ path: at(A, 'a.py'), root: A }], { [A]: py1 })
    await r.m.settled()
    r.m.sync([{ path: at(A, 'a.py'), root: A }], { [A]: py1 })
    await r.m.settled()
    expect(r.sessions).toHaveLength(1)
    r.m.sync([{ path: at(A, 'a.py'), root: A }], { [A]: py2 })
    await r.m.settled()
    expect(r.sessions).toHaveLength(2)
    expect(r.sessions[0].shutdowns).toBe(1)
    expect(r.pythonPaths).toEqual([py1, py2])
    expect(r.sessions[1].opens).toEqual([[at(A, 'a.py'), 'a']])
    await r.m.stopAll()
  })

  it('checks a TypeScript 5 project with typescript5, and notes when only TypeScript 7 is installed or a tsconfig says older', async () => {
    const ts5 = { [at(A, 'a.ts')]: 'a', [at(A, 'package.json')]: JSON.stringify({ devDependencies: { typescript: '^5.9.0' } }) }
    const r = rig({ files: ts5 })
    r.m.sync([{ path: at(A, 'a.ts'), root: A }], {})
    await r.m.settled()
    expect(r.sessions.map((s) => s.launch.server)).toEqual(['typescript5'])
    await r.m.stopAll()
    const only7 = rig({ files: ts5, installed: ['typescript'] })
    only7.m.sync([{ path: at(A, 'a.ts'), root: A }], {})
    await only7.m.settled()
    expect(only7.sessions.map((s) => s.launch.server)).toEqual(['typescript'])
    expect(only7.m.status()[0].notes).toEqual(['typescript5-not-installed'])
    only7.sessions[0].cb.onDiagnostics(at(A, 'tsconfig.json'), [{ ...problem, code: '5102' }])
    await vi.waitFor(() => expect(only7.m.status()[0].notes).toEqual(['typescript5-not-installed', 'older-typescript']))
    await only7.m.stopAll()
  })

  it('clears everything when the app is gone', async () => {
    const r = rig({ files: { [at(A, 'a.ts')]: 'a' } })
    r.m.sync([{ path: at(A, 'a.ts'), root: A }], {})
    await r.m.settled()
    r.sessions[0].cb.onDiagnostics(at(A, 'a.ts'), [problem])
    r.m.appGone()
    await r.m.settled()
    expect(r.sessions[0].closes).toEqual([at(A, 'a.ts')])
    await vi.waitFor(() => expect(r.last(at(A, 'a.ts'))).toEqual([]))
    await r.m.stopAll()
  })

  it('stops every server at stopAll, and one server everywhere at withServerStopped', async () => {
    const B = path.resolve('rootB')
    const r = rig({ files: { [at(A, 'a.ts')]: 'a', [at(B, 'b.ts')]: 'b', [at(A, 'c.py')]: 'c' } })
    r.m.sync([{ path: at(A, 'a.ts'), root: A }, { path: at(B, 'b.ts'), root: B }, { path: at(A, 'c.py'), root: A }], {})
    await r.m.settled()
    await r.m.withServerStopped('typescript', async () => {})
    expect(r.sessions.filter((s) => s.launch.server === 'typescript').every((s) => s.shutdowns === 1)).toBe(true)
    expect(r.m.status().map((s) => s.server)).toEqual(['python'])
    await r.m.stopAll()
    expect(r.live()).toEqual([])
    expect(r.m.logFile('python', A)).toMatch(/python-[0-9a-f]{8}\.log$/)
  })

  // Final review C2: the first use: tabs restored at launch meet a server not yet installed; the install must start it
  it('starts a server refused as not installed once it is installed, and moves a TypeScript 5 root when its server comes', async () => {
    let missing = true
    const ts5 = { [at(A, 'a.ts')]: 'a', [at(A, 'package.json')]: JSON.stringify({ devDependencies: { typescript: '^5.9.0' } }) }
    const installed: LspServerId[] = ['typescript']
    const r = rig({ files: { ...ts5, [at(A, 'b.py')]: 'b' }, installed, refuse: (sv) => (sv === 'python' && missing ? { refused: 'not installed', why: 'not-installed' } : null) })
    r.m.sync([{ path: at(A, 'a.ts'), root: A }, { path: at(A, 'b.py'), root: A }], {})
    await r.m.settled()
    expect(r.sessions.map((x) => x.launch.server)).toEqual(['typescript'])
    missing = false
    installed.push('typescript5')
    r.m.refresh()
    await r.m.settled()
    expect(r.sessions.map((x) => x.launch.server).sort()).toEqual(['python', 'typescript', 'typescript5'])
    expect(r.sessions[0].shutdowns).toBe(1)
    expect(r.m.status().map((x) => `${x.server}:${x.status}`).sort()).toEqual(['python:starting', 'typescript5:starting'])
    await r.m.stopAll()
  })

  it('restarts a running server whose launch changed (a path set in Settings) on refresh', async () => {
    let file = 'one'
    const r = rig({ files: { [at(A, 'a.ts')]: 'a' }, launchFile: () => file })
    r.m.sync([{ path: at(A, 'a.ts'), root: A }], {})
    await r.m.settled()
    r.m.refresh()
    await r.m.settled()
    expect(r.sessions).toHaveLength(1)
    file = 'two'
    r.m.refresh()
    await r.m.settled()
    expect(r.sessions.map((x) => x.launch.file)).toEqual(['one', 'two'])
    expect(r.sessions[0].shutdowns).toBe(1)
    await r.m.stopAll()
  })

  // Final review I1: initialize timing out at the steady-run mark reset the count every time
  it('marks failed a server that never becomes ready, however long each attempt took', async () => {
    let clock = 0
    const r = rig({ files: { [at(A, 'a.ts')]: 'a' }, timings: { stableMs: 30_000 }, now: () => clock })
    r.m.sync([{ path: at(A, 'a.ts'), root: A }], {})
    await r.m.settled()
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(r.sessions).toHaveLength(i + 1))
      clock += 31_000
      r.sessions[i].cb.onExit({ crashed: true, reason: 'it did not answer initialize' })
    }
    await new Promise((res) => setTimeout(res, 50))
    expect(r.sessions).toHaveLength(3)
    expect(r.m.status()[0]).toMatchObject({ status: 'failed', why: 'crashed' })
  })

  // Final review I3: pyright watches nothing itself; a Python file changed on disk that is not open is told to it
  it('tells a Python server of a change to a file it has not open, and nothing to a TypeScript one', async () => {
    const r = rig({ files: { [at(A, 'a.py')]: 'a', [at(A, 'b.ts')]: 'b' } })
    r.m.sync([{ path: at(A, 'a.py'), root: A }, { path: at(A, 'b.ts'), root: A }], {})
    await r.m.settled()
    r.m.saved([at(A, 'util.py'), at(A, 'pyproject.toml'), at(A, 'notes.md')], [at(A, 'gone.py')])
    await r.m.settled()
    const py = r.sessions.find((x) => x.launch.server === 'python')!
    const ts = r.sessions.find((x) => x.launch.server === 'typescript')!
    expect(py.changes).toEqual([[at(A, 'util.py'), 'changed'], [at(A, 'pyproject.toml'), 'changed'], [at(A, 'gone.py'), 'deleted']])
    expect(ts.changes).toEqual([])
    await r.m.stopAll()
  })

  // Final review I4: a root stopped to make room comes back when the person saves a file in it; a failed one on restart
  it('starts again a root stopped to make room when a file of it is saved, and a failed one on restart', async () => {
    const roots = ['r1', 'r2', 'r3', 'r4', 'r5'].map((n) => path.resolve(n))
    const files = Object.fromEntries(roots.map((root) => [at(root, 'a.ts'), 'x']))
    const r = rig({ files })
    r.m.sync(roots.map((root) => ({ path: at(root, 'a.ts'), root })), {})
    await r.m.settled()
    expect(r.m.status().find((x) => x.root === roots[0])).toMatchObject({ status: 'stopped', why: 'room' })
    r.files[at(roots[0], 'a.ts')] = 'y'
    r.m.saved([at(roots[0], 'a.ts')])
    await r.m.settled()
    expect(r.m.status().find((x) => x.root === roots[0])?.status).toBe('starting')
    expect(r.live()).toHaveLength(4)
    const one = rig({ files: { [at(A, 'a.ts')]: 'a' } })
    one.m.sync([{ path: at(A, 'a.ts'), root: A }], {})
    await one.m.settled()
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(one.sessions).toHaveLength(i + 1))
      one.sessions[i].cb.onExit({ crashed: true, reason: 'boom' })
    }
    await vi.waitFor(() => expect(one.m.status()[0]?.status).toBe('failed'))
    one.m.restart('typescript', A)
    await one.m.settled()
    expect(one.sessions).toHaveLength(4)
    await r.m.stopAll()
    await one.m.stopAll()
  })

  // Final review M1
  it('keeps to four servers when a crashed one restarts', async () => {
    const roots = ['r1', 'r2', 'r3', 'r4', 'r5'].map((n) => path.resolve(n))
    const files = Object.fromEntries(roots.map((root) => [at(root, 'a.ts'), 'x']))
    const r = rig({ files, timings: { backoffMs: [30, 30] } })
    r.m.sync(roots.slice(0, 4).map((root) => ({ path: at(root, 'a.ts'), root })), {})
    await r.m.settled()
    r.sessions[0].cb.onExit({ crashed: true, reason: 'boom' })
    // The crashed process is gone: it no longer counts as live
    r.sessions[0].shutdowns = 1
    r.m.sync(roots.map((root) => ({ path: at(root, 'a.ts'), root })), {})
    await r.m.settled()
    await new Promise((res) => setTimeout(res, 100))
    await r.m.settled()
    expect(r.live().length).toBeLessThanOrEqual(4)
    await r.m.stopAll()
  })

  // Final review M2
  it('stops at stopAll a server an open set still being read would have started', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => (release = res))
    const r = rig({ files: { [at(A, 'a.ts')]: 'a' }, readDelay: () => gate })
    r.m.sync([{ path: at(A, 'a.ts'), root: A }], {})
    // The open set is being read when the Host leaves
    await new Promise((res) => setTimeout(res, 20))
    const stopping = r.m.stopAll()
    release()
    await stopping
    await r.m.settled()
    expect(r.live()).toEqual([])
  })

  // Final review M7, M8, M13
  it('refuses a path that leaves its root through .., reads unreadable settings as off, and says a file is too large', async () => {
    const big = at(A, 'big.ts')
    const r = rig({ files: { [at(A, 'a.ts')]: 'a', [big]: 'x' }, sizes: { [big]: 3 * 1024 * 1024 } })
    r.m.sync([{ path: path.join(A, '..', 'elsewhere', 'a.ts'), root: A }, { path: big, root: A }], {})
    await r.m.settled()
    expect(r.sessions).toEqual([])
    await vi.waitFor(() => expect(r.emitted.flat().find((f) => f.path === big)).toMatchObject({ skipped: 'too-large', problems: [] }))
    const off = rig({ files: { [at(A, 'a.ts')]: 'a' }, settingsFail: true })
    off.m.sync([{ path: at(A, 'a.ts'), root: A }], {})
    await off.m.settled()
    expect(off.sessions).toEqual([])
  })

  // Final review M12: a removal runs inside the manager's chain, after its servers stopped, before any sync relaunches
  it('runs a removal after stopping that server everywhere, before the next sync', async () => {
    const r = rig({ files: { [at(A, 'a.py')]: 'a' } })
    r.m.sync([{ path: at(A, 'a.py'), root: A }], {})
    await r.m.settled()
    const order: string[] = []
    const done = r.m.withServerStopped('python', async () => {
      order.push(`removed with ${r.live().length} live`)
    })
    r.m.sync([{ path: at(A, 'a.py'), root: A }], {})
    await done
    await r.m.settled()
    expect(order).toEqual(['removed with 0 live'])
    await r.m.stopAll()
  })
})