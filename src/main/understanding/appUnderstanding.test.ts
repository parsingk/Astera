// The app's side of How It Works since the Host writes it (E1 §2, §4): a real store and pipeline over a
// real understanding.json, with only the agent faked, so what reaches the file is what the app would
// leave there.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SessionWorkUnit } from '../../core/workUnit/types'
import type { ProjectUnderstanding, WorkRecord } from '../../core/understanding/types'
import { UnderstandingStore } from '../../core/understanding/store'
import { UnderstandingPipeline, type RunRecordInput } from '../../core/understanding/pipeline'
import { readUnderstandingFile, type StoreShape } from '../../core/understanding/read'
import { createAppUnderstanding, type AppUnderstandingDeps } from './appUnderstanding'

let dir: string
let file: string
let root: string

const account = { id: 'a1', label: 'acc', configDir: 'C:/cfg', color: '#fff', createdAt: '2026-01-01T00:00:00.000Z' }

const explanation = {
  overview: 'what changed',
  userVisibleChanges: ['a thing'],
  flow: [{ id: 's', label: 'start', type: 'start', next: [], evidencePaths: ['src/a.ts'] }],
  decisions: [],
  implementation: [{ role: 'r', path: 'src/a.ts' }],
  evidencePaths: ['src/a.ts'],
  needsReview: false
}

const unit = (over: Partial<SessionWorkUnit> = {}): SessionWorkUnit => ({
  id: 'wu-1',
  sessionId: 'sess-abcd1234',
  projectPath: root,
  objective: 'fix the limit check',
  status: 'completed',
  startedAt: '2026-10-02T10:00:00.000Z',
  endedAt: '2026-10-02T10:05:00.000Z',
  sawWrite: true,
  git: { startHead: 'a', endHead: 'b', observedChangedFiles: ['src/a.ts'] },
  encounteredExternalGitChangeIds: [],
  ...over
})

const runInput = (): RunRecordInput & { projectPath: string } => ({
  projectPath: root,
  runId: 'run-1',
  jobName: 'job',
  objective: 'tidy the shortcuts',
  at: '2026-10-02T11:00:00.000Z',
  taskIds: ['t1'],
  tasks: [{ title: 't', outcome: 'completed' }],
  changedFiles: ['src/a.ts']
})

const hostRecord = (id: string, over: Partial<WorkRecord> = {}): WorkRecord => ({
  id,
  at: '2026-10-02T09:00:00.000Z',
  source: { kind: 'job', runId: `run-${id}`, jobName: 'host job', taskIds: [] },
  request: `written by the Host: ${id}`,
  changedFiles: [],
  git: { startHead: null, endHead: null },
  status: 'ready',
  ...over
})

/** What a Host write leaves on disk: the file as it is, with this project's records replaced. */
const hostWrites = async (records: WorkRecord[]): Promise<void> => {
  const cur = await readUnderstandingFile(file)
  const next: StoreShape = { projects: { ...cur.projects, [root]: { records } } }
  // A later mtime than any write the app made in the same millisecond, so the store's stamp moves.
  await new Promise((r) => setTimeout(r, 15))
  await fs.writeFile(file, JSON.stringify(next, null, 2), 'utf8')
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

async function make(
  over: Partial<AppUnderstandingDeps> = {},
  fake: { hold?: Promise<void> } = {}
) {
  const agent = { hold: fake.hold, calls: 0 }
  const store = new UnderstandingStore(file)
  await store.load()
  const pipeline = new UnderstandingPipeline({
    store,
    accountOf: (id) => (id === 'a1' ? account : null),
    descriptors: {} as never,
    generator: () => ({ accountId: 'a1' }),
    lang: () => 'en',
    now: () => '2026-10-02T12:00:00.000Z',
    fileProbe: async () => 'present',
    runAgent: async () => {
      agent.calls += 1
      if (agent.hold) await agent.hold
      return { ok: true, value: explanation }
    }
  })
  const box: { announces: boolean | null } = { announces: null }
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = []
  const logs: string[] = []
  const notified: string[] = []
  const answer: { status: number; body: unknown } = { status: 200, body: { recorded: true } }
  const u = createAppUnderstanding({
    localStore: store,
    localPipeline: pipeline,
    hostAnnounces: () => box.announces,
    orchCall: async (cmd, args) => {
      calls.push({ cmd, args })
      return answer
    },
    readFile: () => readUnderstandingFile(file),
    notify: (r) => notified.push(r),
    log: (m) => logs.push(m),
    ...over
  })
  /** A greeting as ipc.ts delivers it: the sticky answer first, then the switch. */
  const greet = (announces: boolean): Promise<void> => {
    box.announces = announces
    return u.onGreeting(announces)
  }
  return { u, store, pipeline, box, calls, logs, notified, answer, greet, agent }
}

const onDisk = async (): Promise<WorkRecord[]> => (await readUnderstandingFile(file)).projects[root]?.records ?? []

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-appunderstanding-'))
  file = path.join(dir, 'understanding.json')
  root = path.join(dir, 'project')
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('createAppUnderstanding: writer mode', () => {
  for (const [name, before] of [
    ['before any greeting', async () => {}],
    ['in front of an older Host', async (m: Awaited<ReturnType<typeof make>>) => m.greet(false)]
  ] as const) {
    it(`${name} the app records, regenerates and reads with its own store`, async () => {
      const m = await make()
      await before(m)
      await m.u.onUnitClosed(root, unit())
      await m.u.onRunFinished(runInput())
      await m.store.refresh()
      const got = (await m.u.get(root)) as ProjectUnderstanding
      expect(got.records.map((r) => r.source.kind).sort()).toEqual(['job', 'session'])
      expect(got.records.every((r) => r.status === 'ready')).toBe(true)
      const id = got.records[0].id
      await m.u.regenerate(root, id)
      // The local regenerate does not wait: the pipeline's queue does it.
      await m.u.onUnitClosed(root, unit({ status: 'cancelled' }))
      expect(m.agent.calls).toBe(3)
      expect(m.calls).toEqual([])
      expect((await onDisk()).length).toBe(2)
    })
  }

  it('get answers null for a project with no records', async () => {
    const m = await make()
    expect(await m.u.get(root)).toBeNull()
  })
})

describe('createAppUnderstanding: reader mode', () => {
  it('get reads the file the Host wrote, not the app store', async () => {
    const m = await make()
    await m.greet(true)
    await hostWrites([hostRecord('h1')])
    const got = (await m.u.get(root)) as ProjectUnderstanding
    expect(got.records.map((r) => r.id)).toEqual(['h1'])
    expect(m.store.get(root)).toBeUndefined()
  })

  it('get matches the key as the Host spelt it (isSamePath)', async () => {
    const m = await make({ platform: 'win32' })
    await m.greet(true)
    await fs.writeFile(file, JSON.stringify({ projects: { 'D:\\Work\\Repo': { records: [hostRecord('h1')] } } }), 'utf8')
    expect(((await m.u.get('d:/work/repo')) as ProjectUnderstanding).records[0].id).toBe('h1')
  })

  it('a Run finishing is not recorded by the app (the Host records it)', async () => {
    const m = await make()
    await m.greet(true)
    await m.u.onRunFinished(runInput())
    expect(m.agent.calls).toBe(0)
    expect(await onDisk()).toEqual([])
    expect(m.calls).toEqual([])
  })

  it('a closed unit goes to the Host as understanding-unit and is not written here', async () => {
    const m = await make()
    await m.greet(true)
    await m.u.onUnitClosed(root, unit())
    expect(m.calls).toEqual([{ cmd: 'understanding-unit', args: { projectPath: root, unit: unit() } }])
    expect(m.agent.calls).toBe(0)
    expect(await onDisk()).toEqual([])
  })

  it('a 409 or a lost link on understanding-unit is logged and dropped, never written here', async () => {
    const m = await make()
    await m.greet(true)
    m.answer.status = 409
    m.answer.body = { error: 'NOT_WRITER' }
    await m.u.onUnitClosed(root, unit())
    const lost = await make({
      orchCall: async () => {
        throw new Error('the Host is gone')
      }
    })
    await lost.greet(true)
    await lost.u.onUnitClosed(root, unit())
    expect(m.logs.some((l) => l.includes('409'))).toBe(true)
    expect(lost.logs.some((l) => l.includes('the Host is gone'))).toBe(true)
    expect(m.agent.calls + lost.agent.calls).toBe(0)
    expect(await onDisk()).toEqual([])
  })

  it('regenerate goes to the Host as understanding-regenerate, and a refusal rejects with its error', async () => {
    const m = await make()
    await m.greet(true)
    await m.u.regenerate(root, 'h1')
    expect(m.calls).toEqual([{ cmd: 'understanding-regenerate', args: { projectPath: root, recordId: 'h1' } }])
    m.answer.status = 404
    m.answer.body = { error: 'unknown record: h2' }
    await expect(m.u.regenerate(root, 'h2')).rejects.toThrow('unknown record: h2')
    expect(m.agent.calls).toBe(0)
  })

  it('regenerate names the project as the file spells it, so a record get showed is the one the Host finds', async () => {
    const m = await make({ platform: 'win32' })
    await m.greet(true)
    await fs.writeFile(file, JSON.stringify({ projects: { 'D:\\Work\\Repo': { records: [hostRecord('h1')] } } }), 'utf8')
    await m.u.regenerate('d:/work/repo', 'h1')
    expect(m.calls).toEqual([{ cmd: 'understanding-regenerate', args: { projectPath: 'D:\\Work\\Repo', recordId: 'h1' } }])
  })

  it("the Host's understanding-state push reaches the renderer", async () => {
    const m = await make()
    await m.greet(true)
    m.u.onHostPush(root)
    expect(m.notified).toEqual([root])
  })
})

describe('createAppUnderstanding: the switch', () => {
  it('writer to reader waits for the generation in flight, and the record it writes survives (Review Focus 1)', async () => {
    const hold = deferred()
    const m = await make({}, { hold: hold.promise })
    void m.u.onUnitClosed(root, unit())
    // The record is saved as generating before the agent runs.
    await new Promise((r) => setTimeout(r, 30))
    expect((await onDisk())[0]?.status).toBe('generating')

    let switched = false
    const greeting = m.greet(true).then(() => (switched = true))
    // The Host, now the writer, records a Run meanwhile, from the file.
    const local = (await onDisk())[0]
    await hostWrites([hostRecord('h1'), local])
    await new Promise((r) => setTimeout(r, 30))
    expect(switched).toBe(false)
    // Still the writer while it drains: a read is the app store's.
    expect(m.calls).toEqual([])

    hold.resolve()
    await greeting
    const records = ((await m.u.get(root)) as ProjectUnderstanding).records
    expect(records.map((r) => [r.id, r.status])).toEqual([
      ['h1', 'ready'],
      [local.id, 'ready']
    ])
    // Reader now.
    await m.u.onUnitClosed(root, unit())
    expect(m.calls.map((c) => c.cmd)).toEqual(['understanding-unit'])
  })

  it('a Run finishing while the switch drains is not recorded by the app (Review Focus 2)', async () => {
    const hold = deferred()
    const m = await make({}, { hold: hold.promise })
    void m.u.onUnitClosed(root, unit())
    await new Promise((r) => setTimeout(r, 30))
    const greeting = m.greet(true)
    await m.u.onRunFinished(runInput())
    hold.resolve()
    await greeting
    const records = await onDisk()
    expect(records.map((r) => r.source.kind)).toEqual(['session'])
    expect(m.agent.calls).toBe(1)
  })

  it('a drain that outlasts its bound is logged and the app switches anyway', async () => {
    const m = await make({ drainBoundMs: 40 }, { hold: new Promise(() => {}) })
    void m.u.onUnitClosed(root, unit())
    await new Promise((r) => setTimeout(r, 20))
    await m.greet(true)
    expect(m.logs.some((l) => /did not finish/.test(l))).toBe(true)
    await m.u.onUnitClosed(root, unit())
    expect(m.calls.map((c) => c.cmd)).toEqual(['understanding-unit'])
  })

  it('an older Host greeting while the switch drains keeps the app the writer', async () => {
    const hold = deferred()
    const m = await make({}, { hold: hold.promise })
    void m.u.onUnitClosed(root, unit())
    await new Promise((r) => setTimeout(r, 30))
    const first = m.greet(true)
    await m.greet(false)
    hold.resolve()
    await first
    await m.u.onUnitClosed(root, unit({ id: 'wu-2' }))
    expect(m.calls).toEqual([])
    expect(m.agent.calls).toBe(2)
  })

  it('reader to writer reloads the store from the file before the next read and write', async () => {
    const m = await make()
    await m.u.onUnitClosed(root, unit())
    const mine = (await onDisk())[0]
    await m.greet(true)
    await hostWrites([hostRecord('h1'), mine])
    await m.greet(false)
    // The app store, which now holds the Host's write.
    expect(((await m.u.get(root)) as ProjectUnderstanding).records.map((r) => r.id)).toEqual(['h1', mine.id])
    await m.u.onRunFinished(runInput())
    expect((await onDisk()).map((r) => r.id).slice(1)).toEqual(['h1', mine.id])
    expect(m.calls).toEqual([])
  })
})
