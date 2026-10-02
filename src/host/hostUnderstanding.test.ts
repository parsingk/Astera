// The Host's How It Works pipeline (E1 §2, §3): the core store and pipeline, behind the writer rule.
// Real store file, real settings file, real validation; only the agent is fake (the runAgent seam).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { createHostUnderstanding, NOT_WRITER, type HostUnderstandingDeps } from './hostUnderstanding'
import { hostAddress } from './address'
import { encodeLine, createLineReader } from './framing'
import { startHostServer, type HostServer } from './server'
import { HOST_PROTOCOL, HOST_YIELD_UNDERSTANDING } from '../core/host/protocol'
import { versionOnlyOrchCall } from '../core/host/orchProtocol'
import type { StoreShape } from '../core/understanding/read'
import type { WorkRecord } from '../core/understanding/types'
import type { SessionWorkUnit } from '../core/workUnit/types'
import type { RunRecordInput } from '../core/understanding/pipeline'
import type { WorktreeInfo } from '../core/types'

let dir: string
let project: string
let worktree: string
const file = (): string => path.join(dir, 'understanding.json')
const settings = (o: Record<string, unknown>): Promise<void> => fs.writeFile(path.join(dir, 'app-settings.json'), JSON.stringify(o))
// Read synchronously, so a spy on the promise API sees only the store's own reads.
const onDisk = async (): Promise<StoreShape> => JSON.parse(readFileSync(file(), 'utf8')) as StoreShape
const recordsOnDisk = async (root: string): Promise<WorkRecord[]> => {
  try {
    return (await onDisk()).projects[root]?.records ?? []
  } catch {
    return []
  }
}

const account = { id: 'a1', label: 'acc', configDir: 'C:/cfg', color: '#fff', createdAt: '2026-01-01T00:00:00.000Z' }
const explanation = {
  overview: 'Made the limit dialog the signal.',
  userVisibleChanges: ['The session unblocks itself'],
  flow: [{ id: 's', label: 'Dialog seen', type: 'start', next: [], evidencePaths: ['src/a.ts'] }],
  decisions: [],
  implementation: [{ role: 'detect', path: 'src/a.ts' }],
  evidencePaths: ['src/a.ts'],
  needsReview: false
}
const ON = { workUnitTrackingEnabled: true, generator: { accountId: 'a1' }, lang: 'en' }

const runInput = (over: Partial<RunRecordInput & { projectPath: string }> = {}): RunRecordInput & { projectPath: string } => ({
  projectPath: project,
  runId: 'run-1',
  jobName: 'Tidy shortcuts',
  objective: 'Find the clashing shortcuts and tidy them',
  at: '2026-10-02T11:00:00.000Z',
  taskIds: ['t1'],
  tasks: [{ title: 'find', outcome: 'completed' }],
  changedFiles: ['src/a.ts'],
  validation: { status: 'passed' },
  ...over
})
const unit = (): SessionWorkUnit => ({
  id: 'wu-1',
  sessionId: 'sess-abcd1234',
  projectPath: project,
  objective: 'Fix the limit detection',
  status: 'completed',
  startedAt: '2026-10-02T10:00:00.000Z',
  endedAt: '2026-10-02T10:05:00.000Z',
  sawWrite: true,
  git: { startHead: 'a', endHead: 'b', observedChangedFiles: ['src/a.ts'] },
  encounteredExternalGitChangeIds: []
})

const make = (over: Partial<HostUnderstandingDeps> = {}) => {
  const box = { writer: true, worktrees: [] as WorktreeInfo[] }
  const pushed: string[] = []
  const logs: string[] = []
  const prompts: string[] = []
  const u = createHostUnderstanding({
    file: file(),
    profileDir: dir,
    writer: () => box.writer,
    accounts: () => [account],
    descriptors: {} as never,
    worktrees: () => box.worktrees,
    log: (m) => logs.push(m),
    push: (root) => pushed.push(root),
    runAgent: async (a) => {
      prompts.push(a.prompt)
      return { ok: true, value: explanation }
    },
    ...over
  })
  return { u, box, pushed, logs, prompts }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hostunderstanding-'))
  project = path.join(dir, 'project')
  worktree = path.join(dir, 'wt', 'project-1')
  await fs.mkdir(path.join(project, 'src'), { recursive: true })
  await fs.writeFile(path.join(project, 'src', 'a.ts'), '// a', 'utf8')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10 })
})

describe('createHostUnderstanding', () => {
  it('as the writer, records a finished Run in the file, fills it in, and pushes the root', async () => {
    await settings(ON)
    const { u, pushed } = make()
    await u.load()
    await u.onRunFinished(runInput())
    await vi.waitFor(async () => expect((await recordsOnDisk(project))[0]?.status).toBe('ready'))
    const [r] = await recordsOnDisk(project)
    expect(r.source).toEqual({ kind: 'job', runId: 'run-1', jobName: 'Tidy shortcuts', taskIds: ['t1'] })
    expect(r.explanation?.overview).toBe('Made the limit dialog the signal.')
    expect(pushed.length).toBeGreaterThanOrEqual(2) // the generating row, then the result
    expect(new Set(pushed)).toEqual(new Set([project]))
  })

  it('as the writer, records a closed session unit', async () => {
    await settings(ON)
    const { u } = make()
    await u.load()
    await expect(u.onUnitClosed(project, unit())).resolves.toEqual({ ok: true })
    await vi.waitFor(async () => expect((await recordsOnDisk(project))[0]?.status).toBe('ready'))
    expect((await recordsOnDisk(project))[0].source.kind).toBe('session')
  })

  it('not the writer: writes nothing for a Run, a unit or a regenerate, and regenerate answers 409', async () => {
    await settings(ON)
    const { u, box, pushed } = make()
    await u.load()
    box.writer = false
    expect(u.isWriter()).toBe(false)
    await u.onRunFinished(runInput())
    await expect(u.onUnitClosed(project, unit())).resolves.toEqual({ ok: false, reason: NOT_WRITER })
    await expect(u.regenerate(project, 'r1')).resolves.toEqual({ ok: false, status: 409, error: NOT_WRITER })
    expect(NOT_WRITER).toBe('an older Astera app is writing How It Works records; regenerate there')
    await new Promise((r) => setTimeout(r, 50))
    await expect(fs.stat(file())).rejects.toThrow()
    expect(pushed).toEqual([])
  })

  it('a writer() that throws is read as not the writer', async () => {
    await settings(ON)
    const { u } = make({ writer: () => { throw new Error('boom') } })
    expect(u.isWriter()).toBe(false)
  })

  it('load marks a record left generating as failed INTERRUPTED, through the Host instance', async () => {
    await settings(ON)
    const left: WorkRecord = {
      id: 'old',
      at: '2026-10-01T00:00:00.000Z',
      source: { kind: 'job', runId: 'r0', jobName: 'j', taskIds: [] },
      request: 'x',
      changedFiles: [],
      git: { startHead: null, endHead: null },
      status: 'generating'
    }
    await fs.writeFile(file(), JSON.stringify({ projects: { [project]: { records: [left] } } }))
    const { u } = make()
    await u.load()
    await u.onRunFinished(runInput())
    await vi.waitFor(async () => expect((await recordsOnDisk(project))[0]?.status).toBe('ready'))
    const old = (await recordsOnDisk(project)).find((r) => r.id === 'old')
    expect(old?.status).toBe('failed')
    expect(old?.reason).toBe('INTERRUPTED')
  })

  it('reads the settings per call: tracking turned off between two Runs records only the first', async () => {
    await settings(ON)
    const { u } = make()
    await u.load()
    await u.onRunFinished(runInput())
    await vi.waitFor(async () => expect((await recordsOnDisk(project))[0]?.status).toBe('ready'))
    await settings({ ...ON, workUnitTrackingEnabled: false })
    await u.onRunFinished(runInput({ runId: 'run-2' }))
    await new Promise((r) => setTimeout(r, 50))
    expect((await recordsOnDisk(project)).map((r) => (r.source.kind === 'job' ? r.source.runId : ''))).toEqual(['run-1'])
  })

  it('reads the language per call', async () => {
    await settings({ ...ON, lang: 'ko' })
    const { u, prompts } = make()
    await u.load()
    await u.onRunFinished(runInput())
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    await settings({ ...ON, lang: 'en' })
    await u.onRunFinished(runInput({ runId: 'run-2' }))
    await vi.waitFor(() => expect(prompts).toHaveLength(2))
    expect(prompts[0]).toContain('in Korean')
    expect(prompts[1]).toContain('in English')
  })

  it('tracking needs exactly true; no settings file means off', async () => {
    const { u } = make()
    await u.load()
    await u.onRunFinished(runInput())
    await settings({ ...ON, workUnitTrackingEnabled: 'yes' })
    await u.onRunFinished(runInput())
    await new Promise((r) => setTimeout(r, 50))
    expect(await recordsOnDisk(project)).toEqual([])
  })

  it('tracking off: a finished Run records nothing and logs one line', async () => {
    await settings({ ...ON, workUnitTrackingEnabled: false })
    const { u, logs } = make()
    await u.load()
    await u.onRunFinished(runInput())
    await new Promise((r) => setTimeout(r, 50))
    expect(await recordsOnDisk(project)).toEqual([])
    expect(logs.filter((l) => l.includes('run-1'))).toHaveLength(1)
    expect(logs.find((l) => l.includes('run-1'))).toMatch(/tracking is off/)
  })

  it('an unreadable settings file records nothing for a Run and logs it', async () => {
    await fs.writeFile(path.join(dir, 'app-settings.json'), '{ not json')
    const { u, logs } = make()
    await u.load()
    await u.onRunFinished(runInput())
    await new Promise((r) => setTimeout(r, 50))
    expect(await recordsOnDisk(project)).toEqual([])
    expect(logs.filter((l) => l.includes('run-1'))).toHaveLength(1)
    expect(logs.some((l) => l.includes('app-settings.json'))).toBe(true)
  })

  it('a missing generator account fails the record with NO_GENERATOR_ACCOUNT', async () => {
    await settings({ ...ON, generator: { accountId: 'gone' } })
    const { u } = make()
    await u.load()
    await u.onRunFinished(runInput())
    await vi.waitFor(async () => expect((await recordsOnDisk(project))[0]?.status).toBe('failed'))
    expect((await recordsOnDisk(project))[0].reason).toBe('NO_GENERATOR_ACCOUNT')
  })

  it('folds a worktree path onto its repository with repoPathOf over the Host registry', async () => {
    await settings(ON)
    const { u, box, pushed } = make()
    box.worktrees = [{ path: worktree, repoPath: project } as WorktreeInfo]
    await u.load()
    await u.onRunFinished(runInput({ projectPath: worktree }))
    await vi.waitFor(async () => expect((await recordsOnDisk(project))[0]?.status).toBe('ready'))
    expect(Object.keys((await onDisk()).projects)).toEqual([project])
    expect(new Set(pushed)).toEqual(new Set([project]))
    await u.onUnitClosed(worktree, unit())
    await vi.waitFor(async () => expect(await recordsOnDisk(project)).toHaveLength(2))
    expect(Object.keys((await onDisk()).projects)).toEqual([project])
  })

  it('regenerate: an unknown record is 404; a known one answers its id and is filled in again', async () => {
    await settings(ON)
    const { u, prompts } = make()
    await u.load()
    await expect(u.regenerate(project, 'nope')).resolves.toMatchObject({ ok: false, status: 404 })
    await u.onRunFinished(runInput())
    await vi.waitFor(async () => expect((await recordsOnDisk(project))[0]?.status).toBe('ready'))
    const id = (await recordsOnDisk(project))[0].id
    await expect(u.regenerate(worktree, id)).resolves.toMatchObject({ ok: false, status: 404 }) // not folded: another project
    await expect(u.regenerate(project, id)).resolves.toEqual({ ok: true, id })
    await vi.waitFor(() => expect(prompts).toHaveLength(2))
    await vi.waitFor(async () => expect((await recordsOnDisk(project))[0]?.status).toBe('ready'))
  })

  it('reads the writer per write: a generation that ends after the duty is kept elsewhere writes nothing more', async () => {
    await settings(ON)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const { u, box } = make({
      runAgent: async () => {
        await gate
        return { ok: true, value: explanation }
      }
    })
    await u.load()
    await u.onRunFinished(runInput())
    await vi.waitFor(async () => expect((await recordsOnDisk(project))[0]?.status).toBe('generating'))
    box.writer = false
    release()
    await new Promise((r) => setTimeout(r, 100))
    expect((await recordsOnDisk(project))[0].status).toBe('generating')
  })

  it('re-reads the file when it becomes the writer again, so an app’s records written meanwhile are kept', async () => {
    await settings(ON)
    const { u, box } = make()
    await u.load()
    await u.onRunFinished(runInput())
    await vi.waitFor(async () => expect((await recordsOnDisk(project))[0]?.status).toBe('ready'))
    box.writer = false
    await u.onRunFinished(runInput({ runId: 'skipped' }))
    // An older app, the writer meanwhile, adds its own record.
    const s = await onDisk()
    const appRecord: WorkRecord = { ...s.projects[project].records[0], id: 'by-app', source: { kind: 'job', runId: 'app-run', jobName: 'j', taskIds: [] } }
    s.projects[project].records.unshift(appRecord)
    await fs.writeFile(file(), JSON.stringify(s))
    box.writer = true
    await u.onRunFinished(runInput({ runId: 'run-3' }))
    await vi.waitFor(async () => expect(await recordsOnDisk(project)).toHaveLength(3))
    await vi.waitFor(async () => expect((await recordsOnDisk(project))[0]?.status).toBe('ready'))
    const runs = (await recordsOnDisk(project)).map((r) => (r.source.kind === 'job' ? r.source.runId : ''))
    expect(runs).toEqual(['run-3', 'app-run', 'run-1'])
  })

  /** What an older app does to the file while it is the writer: adds its own record on top. */
  const appWrites = async (id: string): Promise<void> => {
    const s = await onDisk()
    const base = s.projects[project].records[0]
    s.projects[project].records.unshift({ ...base, id, source: { kind: 'job', runId: id, jobName: 'j', taskIds: [] } })
    await fs.writeFile(file(), JSON.stringify(s))
  }
  const runIds = async (): Promise<string[]> => (await recordsOnDisk(project)).map((r) => (r.source.kind === 'job' ? r.source.runId : ''))

  // Review I1 (a): an app attached, wrote and left with no Host call in between.
  it('keeps a record an app wrote while the Host made no call at all', async () => {
    await settings(ON)
    const { u } = make()
    await u.load()
    await u.onRunFinished(runInput())
    await vi.waitFor(async () => expect((await recordsOnDisk(project))[0]?.status).toBe('ready'))
    await appWrites('app-run')
    await u.onRunFinished(runInput({ runId: 'run-2' }))
    await vi.waitFor(async () => expect(await runIds()).toEqual(['run-2', 'app-run', 'run-1']))
    await vi.waitFor(async () => expect((await recordsOnDisk(project))[0]?.status).toBe('ready'))
    expect(await runIds()).toEqual(['run-2', 'app-run', 'run-1'])
  })

  // Review I1 (b): the app wrote during the Host's own agent round trip.
  it('keeps a record an app wrote during the Host’s own generation', async () => {
    await settings(ON)
    let during: (() => Promise<void>) | null = null
    const { u } = make({
      runAgent: async () => {
        if (during) await during()
        return { ok: true, value: explanation }
      }
    })
    await u.load()
    await u.onRunFinished(runInput())
    await vi.waitFor(async () => expect((await recordsOnDisk(project))[0]?.status).toBe('ready'))
    during = () => appWrites('app-run')
    await u.onRunFinished(runInput({ runId: 'run-2' }))
    await vi.waitFor(async () => expect((await recordsOnDisk(project)).find((r) => r.source.kind === 'job' && r.source.runId === 'run-2')?.status).toBe('ready'))
    expect(await runIds()).toEqual(['app-run', 'run-2', 'run-1'])
    // The Host's own record, generating while the file was re-read, was not marked interrupted.
    expect((await recordsOnDisk(project)).every((r) => r.reason !== 'INTERRUPTED')).toBe(true)
  })

  it('does not read understanding.json again when nothing outside changed it', async () => {
    await settings(ON)
    const { u } = make()
    await u.load()
    const real = fsp.readFile
    const reads: string[] = []
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation((async (...args: Parameters<typeof real>) => {
      reads.push(String(args[0]))
      return real(...args)
    }) as typeof real)
    try {
      await u.onRunFinished(runInput())
      await vi.waitFor(async () => expect((await recordsOnDisk(project))[0]?.status).toBe('ready'))
      reads.length = 0
      await u.onRunFinished(runInput({ runId: 'run-2' }))
      await vi.waitFor(async () => expect(await runIds()).toEqual(['run-2', 'run-1']))
      await vi.waitFor(async () => expect((await recordsOnDisk(project))[0]?.status).toBe('ready'))
      expect(reads.filter((p) => p === file())).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('rides out a busy app-settings.json during the app’s save, and still records the Run', async () => {
    await settings(ON)
    const { u } = make()
    await u.load()
    const real = fsp.readFile
    let busy = 1
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation((async (...args: Parameters<typeof real>) => {
      if (String(args[0]).endsWith('app-settings.json') && busy-- > 0) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      return real(...args)
    }) as typeof real)
    try {
      await u.onRunFinished(runInput())
    } finally {
      spy.mockRestore()
    }
    await vi.waitFor(async () => expect((await recordsOnDisk(project))[0]?.status).toBe('ready'))
  })

  // The gate index.ts hands in, through the real server: an app that keeps the duty attaching between two
  // writes stops the second.
  describe('the one writer, judged by the attached apps', () => {
    let server: HostServer | null = null
    const sockets: net.Socket[] = []
    afterEach(async () => {
      for (const s of sockets.splice(0)) s.destroy()
      await server?.close().catch(() => {})
      server = null
    })
    const attach = async (address: string, hello: Record<string, unknown>): Promise<net.Socket> => {
      const sock = net.connect(address)
      sockets.push(sock)
      await new Promise((r) => sock.once('connect', r))
      const answered = new Promise<void>((resolve) => {
        const read = createLineReader({ onMessage: () => resolve(), onBadLine: () => {}, onHandlerError: () => {} })
        sock.setEncoding('utf8')
        sock.on('data', read)
      })
      sock.write(encodeLine({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', ...hello }))
      await answered
      return sock
    }

    it('writes with no app and a yielding app, and nothing once an app that keeps the duty attaches', async () => {
      await settings(ON)
      const addr = hostAddress({ profileDir: path.join(dir, 'host-profile'), platform: process.platform, tmpDir: dir, protocol: HOST_PROTOCOL })
      const s = await startHostServer({
        address: addr.address,
        dirToPrepare: addr.dirToPrepare,
        version: '9.9.9',
        idleMs: 60_000,
        onIdle: () => {},
        orch: versionOnlyOrchCall({ version: '9.9.9' }),
        pidLives: () => true,
        log: { write: () => {}, close: () => {} }
      })
      server = s
      const { u } = make({ writer: () => !s.appsKeep(HOST_YIELD_UNDERSTANDING) })
      await u.load()
      const runs = async (): Promise<string[]> => (await recordsOnDisk(project)).map((r) => (r.source.kind === 'job' ? r.source.runId : ''))

      await u.onRunFinished(runInput({ runId: 'no-app' }))
      await vi.waitFor(async () => expect(await runs()).toEqual(['no-app']))
      await attach(addr.address, { role: 'app', yields: [HOST_YIELD_UNDERSTANDING] })
      await u.onRunFinished(runInput({ runId: 'yielding-app' }))
      await vi.waitFor(async () => expect(await runs()).toEqual(['yielding-app', 'no-app']))
      await attach(addr.address, { role: 'app', yields: ['journal'] })
      expect(u.isWriter()).toBe(false)
      await u.onRunFinished(runInput({ runId: 'older-app' }))
      await expect(u.regenerate(project, 'whatever')).resolves.toMatchObject({ status: 409 })
      await new Promise((r) => setTimeout(r, 50))
      expect(await runs()).toEqual(['yielding-app', 'no-app'])
    })
  })
})
