import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import type { LanguageServerSettings, LspFileDiagnostics, LspProblem, LspServerId, LspServerStatus } from '../../core/lsp/model'
import { languageServersOf } from '../../core/settings/languageServers'
import { createLspManager } from './manager'
import type { LspLaunch, LspRefused, LspSession } from './session'

// Phase 3 Part 3: the Host's language servers, one per root and language, against fake sessions (no processes)
const A = path.resolve('rootA')
const at = (root: string, name: string): string => path.join(root, name)

interface Fake {
  launch: LspLaunch
  opens: Array<[string, string]>
  closes: string[]
  shutdowns: number
  cb: { onDiagnostics(p: string, problems: LspProblem[]): void; onReady(): void; onExit(why: { crashed: boolean; reason: string }): void }
}

function rig(o: {
  files?: Record<string, string>
  sizes?: Record<string, number>
  installed?: LspServerId[]
  settings?: LanguageServerSettings
  refuse?: (server: LspServerId) => LspRefused | null
  timings?: Parameters<typeof createLspManager>[0]['timings']
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
    settings: async () => o.settings ?? languageServersOf(undefined),
    emit: (f) => emitted.push(f),
    state: (s) => states.push(s),
    log: () => {},
    launch: (d) => {
      pythonPaths.push(d.pythonPath?.pythonPath)
      const refused = o.refuse?.(d.server) ?? null
      return refused ?? { server: d.server, root: d.root, file: 'x', args: [], env: {}, log: 'l' }
    },
    start: (launch, cb) => {
      const f: Fake = { launch, opens: [], closes: [], shutdowns: 0, cb }
      sessions.push(f)
      const s: LspSession = {
        pid: 100 + sessions.length,
        open: (p, text) => f.opens.push([p, text]),
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
      const text = files[p]
      if (text === undefined) throw new Error(`ENOENT ${p}`)
      return Buffer.from(text, 'utf8')
    },
    stat: async (p) => (files[p] === undefined ? null : { size: o.sizes?.[p] ?? files[p].length }),
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

  it('stops every server at stopAll, and one server everywhere at stopServer', async () => {
    const B = path.resolve('rootB')
    const r = rig({ files: { [at(A, 'a.ts')]: 'a', [at(B, 'b.ts')]: 'b', [at(A, 'c.py')]: 'c' } })
    r.m.sync([{ path: at(A, 'a.ts'), root: A }, { path: at(B, 'b.ts'), root: B }, { path: at(A, 'c.py'), root: A }], {})
    await r.m.settled()
    await r.m.stopServer('typescript')
    expect(r.sessions.filter((s) => s.launch.server === 'typescript').every((s) => s.shutdowns === 1)).toBe(true)
    expect(r.m.status().map((s) => s.server)).toEqual(['python'])
    await r.m.stopAll()
    expect(r.live()).toEqual([])
    expect(r.m.logFile('python', A)).toMatch(/python-[0-9a-f]{8}\.log$/)
  })
})
