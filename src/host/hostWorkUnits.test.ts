// The Host's work unit collector (E2 §3, §4): the core collector and store over the sessions the Host
// runs, behind the writer rule. Real store file, real transcript files; the sessions, git, watchers
// and the How It Works pipeline are fakes the test drives.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createHostWorkUnits,
  readWorkUnitTracking,
  workUnitSessionsOf,
  type HostWorkUnitSession,
  type HostWorkUnitsDeps,
  type WorkUnitsPush
} from './hostWorkUnits'
import { makeDescriptors } from '../core/providers/descriptor'
import type { CollectorGit } from '../core/workUnit/collector'
import type { GitRef } from '../core/git/types'
import type { SessionWorkUnit } from '../core/workUnit/types'
import type { WorkUnitState } from '../core/workUnit/store'
import type { Account } from '../core/types'
import { OPERATION_GRACE_MS } from '../core/git/provenance'

let dir: string
let project: string
let t1: string
let t2: string
const file = (): string => path.join(dir, 'workUnits.json')
const onDisk = (): { projects: Record<string, WorkUnitState> } => JSON.parse(readFileSync(file(), 'utf8'))

const account: Account = { id: 'a1', label: 'acc', configDir: 'C:/cfg', color: '#fff', createdAt: '2026-01-01T00:00:00.000Z' }

/** The session wrote something: a unit closes as a record only with this in its own transcript. */
const wrote = (): string =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: {} }] }
  }) + '\n'
/** A claude `/goal` declaration (goalSignal.ts). */
const claudeGoal = (condition: string): string =>
  JSON.stringify({ type: 'attachment', attachment: { type: 'goal_status', sentinel: true, condition } }) + '\n'

interface FakeWatcher {
  onChange: (p: string) => void
  watched: Set<string>
  watch(p: string): void
  unwatch(p: string): void
  close(): void
}
const fakeWatcher = (onChange: (p: string) => void): FakeWatcher => {
  const w: FakeWatcher = {
    onChange,
    watched: new Set(),
    watch: (p) => void w.watched.add(p),
    unwatch: (p) => void w.watched.delete(p),
    close: () => w.watched.clear()
  }
  return w
}

interface Rig {
  deps: HostWorkUnitsDeps
  sessions: HostWorkUnitSession[]
  pushes: WorkUnitsPush[]
  closed: Array<{ projectPath: string; unit: SessionWorkUnit }>
  logs: string[]
  git: CollectorGit & { ref: GitRef; files: string[] | null }
  transcripts: () => FakeWatcher
  gitDirs: () => FakeWatcher
  state: { writer: boolean; tracking: boolean | Error }
}

function rig(over: Partial<HostWorkUnitsDeps> = {}): Rig {
  const state: Rig['state'] = { writer: true, tracking: true }
  const pushes: WorkUnitsPush[] = []
  const closed: Rig['closed'] = []
  const logs: string[] = []
  const sessions: HostWorkUnitSession[] = [{ sessionId: 's1', cwd: project, accountId: 'a1', rolloutPath: null }]
  const transcriptOf = new Map<string, string>([
    ['s1', t1],
    ['s2', t2]
  ])
  const git: Rig['git'] = {
    ref: { branch: 'main', head: 'c0' },
    files: [],
    readRef: async () => git.ref,
    isAncestor: async () => true,
    changedFiles: async () => git.files,
    readRange: async () => ({ commits: [], changedFiles: [] })
  }
  let transcripts: FakeWatcher | null = null
  let gitDirs: FakeWatcher | null = null
  const deps: HostWorkUnitsDeps = {
    file: file(),
    writer: () => state.writer,
    sessions: () => sessions,
    accounts: async () => [account],
    descriptors: makeDescriptors(process.platform),
    statusLinePayload: async (id) => (transcriptOf.has(id) ? { transcript_path: transcriptOf.get(id) } : null),
    tracking: async () => {
      if (state.tracking instanceof Error) throw state.tracking
      return state.tracking
    },
    inRun: () => false,
    understanding: {
      onUnitClosed: async (projectPath, unit) => {
        closed.push({ projectPath, unit })
        return { ok: true }
      }
    },
    push: (m) => pushes.push(m),
    log: (m) => logs.push(m),
    git,
    gitDir: async () => path.join(project, '.git'),
    watchers: {
      transcript: (onChange) => (transcripts = fakeWatcher(onChange)),
      gitDir: (onChange) => (gitDirs = fakeWatcher(onChange))
    },
    ...over
  }
  return {
    deps,
    sessions,
    pushes,
    closed,
    logs,
    git,
    transcripts: () => transcripts!,
    gitDirs: () => gitDirs!,
    state
  }
}

const statePushes = (r: Rig): WorkUnitsPush[] => r.pushes.filter((m) => m.t === 'work-units-state')

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-host-wu-'))
  project = path.join(dir, 'project')
  await fs.mkdir(project)
  t1 = path.join(dir, 't1.jsonl')
  t2 = path.join(dir, 't2.jsonl')
  await fs.writeFile(t1, '{"type":"user","message":{"role":"user","content":"before"}}\n')
  await fs.writeFile(t2, '')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('createHostWorkUnits', () => {
  it('does not start the collector while tracking is off, and writes nothing', async () => {
    const r = rig()
    r.state.tracking = false
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    expect(hw.isRunning()).toBe(false)
    expect(await hw.sessionTasks.start('s1', 'Fix it')).toEqual({ ok: false, reason: 'work unit tracking is off' })
    await hw.settled()
    expect(existsSync(file())).toBe(false)
    expect(r.pushes).toEqual([])
  })

  it('starts the collector on reload once tracking is on, without a Host restart (Review Focus 5)', async () => {
    const r = rig()
    r.state.tracking = false
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    r.state.tracking = true
    await hw.reload()
    expect(hw.isRunning()).toBe(true)
    expect((await hw.sessionTasks.start('s1', 'Fix it')).ok).toBe(true)
    // and stops it on the next reload that reads off: the open unit is interrupted, as the app's toggle does
    r.state.tracking = false
    await hw.reload()
    expect(hw.isRunning()).toBe(false)
    await hw.settled()
    expect(onDisk().projects[project].units[0]).toMatchObject({ status: 'interrupted', reason: 'INTERRUPTED_BY_TRACKING_OFF' })
  })

  it('keeps the collector as it was when the settings cannot be read, and says so', async () => {
    const r = rig()
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    expect(hw.isRunning()).toBe(true)
    r.state.tracking = new Error('app-settings.json is not a valid settings file')
    await hw.reload()
    expect(hw.isRunning()).toBe(true)
    expect(r.logs.some((m) => m.includes('app-settings.json is not a valid settings file'))).toBe(true)
  })

  it('records a unit opened by session-task-start, seen through a transcript and a git change, once completed', async () => {
    const r = rig()
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    const started = await hw.sessionTasks.start('s1', 'Fix the limit detection')
    expect(started.ok).toBe(true)
    // the transcript the statusline names is watched, and so is the project's git dir
    expect([...r.transcripts().watched]).toEqual([t1])
    expect([...r.gitDirs().watched]).toEqual([project])
    await fs.appendFile(t1, wrote())
    r.transcripts().onChange(t1)
    r.git.files = ['src/a.ts']
    r.git.ref = { branch: 'main', head: 'c1' }
    r.gitDirs().onChange(project)
    await hw.flush()
    expect(r.closed).toEqual([])
    const done = await hw.sessionTasks.complete('s1', { source: 'agent', summary: 'done' })
    expect(done).toEqual({ ok: true, id: (started as { id: string }).id })
    expect(r.closed).toHaveLength(1)
    expect(r.closed[0].projectPath).toBe(project)
    expect(r.closed[0].unit).toMatchObject({
      id: (started as { id: string }).id,
      sessionId: 's1',
      objective: 'Fix the limit detection',
      status: 'completed',
      sawWrite: true
    })
    expect(r.closed[0].unit.git.observedChangedFiles).toEqual(['src/a.ts'])
  })

  it('a Host roll re-keys an open unit onto the new session, which then closes it into one record (Review Focus 1)', async () => {
    const r = rig()
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    const started = await hw.sessionTasks.start('s1', 'Survive the roll')
    expect(started.ok).toBe(true)
    await fs.appendFile(t1, wrote())
    r.git.files = ['src/a.ts']
    // The roll: the old pty is killed, the new one spawned, then `session-rolled`; the old exit comes later.
    r.sessions.splice(0, 1, { sessionId: 's2', cwd: project, accountId: 'a1', rolloutPath: null })
    hw.onRolled({ oldSessionId: 's1', newSessionId: 's2' })
    await hw.onSessionExit('s1')
    expect(hw.sessionTasks.list(project)).toEqual([expect.objectContaining({ status: 'active', sessionId: 's2' })])
    const done = await hw.sessionTasks.complete('s2', { source: 'agent' })
    expect(done.ok).toBe(true)
    expect(r.closed).toHaveLength(1)
    expect(r.closed[0].unit).toMatchObject({ id: (started as { id: string }).id, sessionId: 's2', status: 'completed', sawWrite: true })
  })

  it('a session that exits interrupts its open unit, as the app does', async () => {
    const r = rig()
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    await hw.sessionTasks.start('s1', 'Left open')
    r.sessions.splice(0, 1)
    await hw.onSessionExit('s1')
    await hw.settled()
    expect(hw.sessionTasks.list(project)).toEqual([
      expect.objectContaining({ status: 'interrupted', reason: 'INTERRUPTED_BY_SESSION_END' })
    ])
    expect(onDisk().projects[project].units[0].status).toBe('interrupted')
    expect(r.closed).toEqual([])
  })

  it('completes and cancels by id, the buttons of the How It Works screen', async () => {
    const r = rig()
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    const a = (await hw.sessionTasks.start('s1', 'One')) as { ok: true; id: string }
    const b = (await hw.sessionTasks.start('s1', 'Two')) as { ok: true; id: string; interruptedId?: string }
    expect(b.interruptedId).toBe(a.id)
    expect(await hw.sessionTasks.cancelById(project, a.id)).toEqual({ ok: true })
    // nothing written by this session, so nothing to record
    expect(await hw.sessionTasks.completeById(project, b.id)).toEqual({ ok: true, recorded: false })
    expect(hw.sessionTasks.list(project)).toEqual([])
    expect(r.closed).toEqual([])
  })

  it('writes nothing and pushes nothing while an attached app keeps the duty', async () => {
    const r = rig()
    r.state.writer = false
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    await hw.writerMayHaveChanged()
    expect(hw.isWriter()).toBe(false)
    expect(hw.isRunning()).toBe(false)
    expect((await hw.sessionTasks.start('s1', 'Fix it')).ok).toBe(false)
    await hw.settled()
    expect(existsSync(file())).toBe(false)
    expect(r.pushes).toEqual([])
  })

  it('drops a write whole when the writer flips under it, and stops once told', async () => {
    const r = rig()
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    await hw.settled()
    const before = readFileSync(file(), 'utf8')
    const pushed = r.pushes.length
    // The app's hello lands between two writes: the next one is checked and dropped.
    r.state.writer = false
    await hw.sessionTasks.start('s1', 'Fix it')
    await hw.settled()
    expect(readFileSync(file(), 'utf8')).toBe(before)
    expect(r.pushes.length).toBe(pushed)
    await hw.writerMayHaveChanged()
    expect(hw.isRunning()).toBe(false)
  })

  // E1's trySet has no await between its gate and its write; here the refresh is one, so the gate is asked again.
  it('drops a write when the writer flips while the store refreshes before it', async () => {
    const r = rig()
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    await hw.settled()
    const before = readFileSync(file(), 'utf8')
    const pushed = r.pushes.length
    const real = fs.stat.bind(fs)
    const stat = vi.spyOn(fs, 'stat').mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
      // the refresh's stamp of workUnits.json: the app's hello lands right then
      if (String(args[0]) === file()) r.state.writer = false
      return real(...args)
    }) as typeof fs.stat)
    try {
      await hw.sessionTasks.start('s1', 'Fix it')
      await hw.settled()
    } finally {
      stat.mockRestore()
    }
    expect(readFileSync(file(), 'utf8')).toBe(before)
    expect(r.pushes.length).toBe(pushed)
  })

  it('reads the file again when it becomes the writer, so what the app wrote meanwhile is kept', async () => {
    const r = rig()
    r.state.writer = false
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    await hw.writerMayHaveChanged()
    // the older app, the writer meanwhile, left a unit of a project with no live session here
    const other = path.join(dir, 'other')
    const appUnit: SessionWorkUnit = {
      id: 'wu-app',
      sessionId: 'gone',
      projectPath: other,
      objective: 'The app wrote this',
      status: 'interrupted',
      startedAt: '2026-10-02T10:00:00.000Z',
      git: { startHead: null, observedChangedFiles: [] },
      encounteredExternalGitChangeIds: []
    }
    await fs.writeFile(file(), JSON.stringify({ projects: { [other]: { units: [appUnit], cursors: [], externalGitChanges: [] } } }))
    r.state.writer = true
    await hw.writerMayHaveChanged()
    expect(hw.isRunning()).toBe(true)
    await hw.sessionTasks.start('s1', 'Fix it')
    await hw.settled()
    expect(onDisk().projects[other].units[0].id).toBe('wu-app')
    expect(onDisk().projects[project].units[0].objective).toBe('Fix it')
  })

  // Ruling 3: a push says the screen has something new to show, so it follows the units, not every write.
  it('pushes work-units-state with the raw session cwd when the units changed, and not for a cursor-only round', async () => {
    const r = rig()
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    await hw.settled()
    const count = (): number => statePushes(r).length
    let n = count()
    // a transcript line with nothing in it for a unit: the cursor moves on disk, nothing is pushed
    const cursorBefore = onDisk().projects[project].cursors.find((c) => c.sessionId === 's1')!.offset
    await fs.appendFile(t1, '{"type":"user","message":{"role":"user","content":"just talking"}}\n')
    r.transcripts().onChange(t1)
    await hw.flush()
    await hw.settled()
    expect(onDisk().projects[project].cursors.find((c) => c.sessionId === 's1')!.offset).toBeGreaterThan(cursorBefore)
    expect(count()).toBe(n)
    // start, cancel, complete and an exit's interruption each push
    await hw.sessionTasks.start('s1', 'One')
    await hw.settled()
    expect(count()).toBeGreaterThan(n)
    n = count()
    await hw.sessionTasks.cancel('s1', 'not needed')
    await hw.settled()
    expect(count()).toBeGreaterThan(n)
    n = count()
    await hw.sessionTasks.start('s1', 'Two')
    await fs.appendFile(t1, wrote())
    r.git.files = ['src/a.ts']
    await hw.sessionTasks.complete('s1', { source: 'agent' })
    await hw.settled()
    expect(r.closed).toHaveLength(1)
    expect(count()).toBeGreaterThan(n)
    await hw.sessionTasks.start('s1', 'Three')
    await hw.settled()
    n = count()
    r.sessions.splice(0, 1)
    await hw.onSessionExit('s1')
    await hw.settled()
    expect(hw.sessionTasks.list(project)).toEqual([expect.objectContaining({ status: 'interrupted' })])
    expect(count()).toBeGreaterThan(n)
    expect(statePushes(r).every((m) => m.t === 'work-units-state' && m.root === project)).toBe(true)
  })

  // At Host leave a round the collector armed earlier can still fire; it must write and watch nothing.
  it('after dispose, a round still to come persists nothing, pushes nothing and watches nothing', async () => {
    const r = rig()
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    await hw.sessionTasks.start('s1', 'Open at leave')
    await hw.settled()
    const before = readFileSync(file(), 'utf8')
    const pushed = r.pushes.length
    await fs.appendFile(t1, wrote())
    r.transcripts().onChange(t1)
    hw.dispose()
    // the round the transcript change armed, run now rather than waited for
    await hw.flush()
    await hw.settled()
    expect(readFileSync(file(), 'utf8')).toBe(before)
    expect(r.pushes.length).toBe(pushed)
    expect([...r.transcripts().watched]).toEqual([])
    expect([...r.gitDirs().watched]).toEqual([])
    // and the open unit was not interrupted on the way out: the next Host's start does that
    expect(hw.sessionTasks.list(project)).toEqual([expect.objectContaining({ status: 'active' })])
  })

  // On the Host a session can end while busy, and the spawner then sends no idle edge.
  it('a session that exits while busy interrupts its unit and closes its attribution window', async () => {
    let clock = Date.parse('2026-10-03T09:00:00.000Z')
    const r = rig({ now: () => clock })
    r.sessions.push({ sessionId: 's2', cwd: project, accountId: 'a1', rolloutPath: null })
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    r.gitDirs().onChange(project)
    await hw.flush()
    await hw.sessionTasks.start('s1', 'Busy at the end')
    hw.onBusy('s1', true)
    await hw.settled()
    r.sessions.splice(0, 1)
    await hw.onSessionExit('s1')
    expect(hw.sessionTasks.list(project)).toEqual([
      expect.objectContaining({ status: 'interrupted', reason: 'INTERRUPTED_BY_SESSION_END' })
    ])
    // past the grace, a HEAD move is no longer the dead session's: it is recorded as from outside
    clock += OPERATION_GRACE_MS + 1_000
    r.git.ref = { branch: 'main', head: 'c1' }
    r.gitDirs().onChange(project)
    await hw.flush()
    await hw.settled()
    expect(onDisk().projects[project].externalGitChanges).toHaveLength(1)
  })

  it('pushes work-units-goal-ignored when a goal arrives while a unit is open', async () => {
    const r = rig()
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    const open = (await hw.sessionTasks.start('s1', 'Already open')) as { ok: true; id: string }
    await fs.appendFile(t1, claudeGoal('make the tests pass'))
    r.transcripts().onChange(t1)
    await hw.flush()
    expect(r.pushes.filter((m) => m.t === 'work-units-goal-ignored')).toEqual([
      { t: 'work-units-goal-ignored', projectPath: project, objective: 'make the tests pass', blockingUnitId: open.id }
    ])
  })

  it('a goal from a session inside a Run opens nothing', async () => {
    const r = rig({ inRun: (id) => id === 's1' })
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    await fs.appendFile(t1, claudeGoal('make the tests pass'))
    await hw.flush()
    await hw.flush()
    expect(hw.sessionTasks.list(project)).toEqual([])
  })

  it('at start, interrupts the units of sessions that are not alive', async () => {
    const stale: SessionWorkUnit = {
      id: 'wu-old',
      sessionId: 'dead',
      projectPath: project,
      objective: 'From the last Host',
      status: 'active',
      startedAt: '2026-10-02T10:00:00.000Z',
      git: { startHead: null, observedChangedFiles: [] },
      encounteredExternalGitChangeIds: []
    }
    await fs.writeFile(file(), JSON.stringify({ projects: { [project]: { units: [stale], cursors: [], externalGitChanges: [] } } }))
    const r = rig()
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    await hw.settled()
    expect(onDisk().projects[project].units[0]).toMatchObject({ id: 'wu-old', status: 'interrupted', reason: 'INTERRUPTED_BY_APP_RESTART' })
  })

  it('watches the transcripts of the listed sessions, Codex by the note rollout path, and lets go of the rest', async () => {
    const r = rig({ accounts: async () => [account, { ...account, id: 'c1', provider: 'codex' }] })
    const rollout = path.join(dir, 'rollout.jsonl')
    await fs.writeFile(rollout, '')
    r.sessions.push({ sessionId: 'x1', cwd: project, accountId: 'c1', rolloutPath: rollout })
    // a session whose account is gone is not listed: the provider, and so the file, cannot be told
    r.sessions.push({ sessionId: 'x2', cwd: project, accountId: 'nobody', rolloutPath: null })
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    expect([...r.transcripts().watched].sort()).toEqual([t1, rollout].sort())
    r.sessions.splice(0, 1)
    await hw.flush()
    expect([...r.transcripts().watched]).toEqual([rollout])
    r.state.tracking = false
    await hw.reload()
    expect([...r.transcripts().watched]).toEqual([])
    expect([...r.gitDirs().watched]).toEqual([])
  })

  it('knows a session that started after the last round when it declares a task', async () => {
    const r = rig()
    const later = r.sessions.splice(0, 1)[0]
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    r.sessions.push(later)
    expect((await hw.sessionTasks.start('s1', 'Fix it')).ok).toBe(true)
  })

  describe('git moves Astera or the session made', () => {
    /** Starts, takes the git baseline, then moves HEAD c0 -> c1 inside `during` and runs a git round. */
    const moveHead = async (during: (hw: ReturnType<typeof createHostWorkUnits>) => Promise<void> | void): Promise<number> => {
      const r = rig()
      const hw = createHostWorkUnits(r.deps)
      await hw.start()
      r.gitDirs().onChange(project)
      await hw.flush()
      await during(hw)
      r.git.ref = { branch: 'main', head: 'c1' }
      r.gitDirs().onChange(project)
      await hw.flush()
      await hw.settled()
      return onDisk().projects[project].externalGitChanges.length
    }

    it('a HEAD move with nothing of Astera around it is recorded as from outside', async () => {
      expect(await moveHead(() => {})).toBe(1)
    })

    it('a HEAD move while the session is busy is the session own (its busy edge)', async () => {
      expect(
        await moveHead(async (hw) => {
          hw.onBusy('s1', true)
          await hw.settled()
        })
      ).toBe(0)
    })

    it('a HEAD move inside a Host git-op is Astera own', async () => {
      expect(await moveHead((hw) => hw.onGitOp({ t: 'git-op', op: 'op-1', phase: 'begin', kind: 'job-merge', cwd: project }))).toBe(0)
    })
  })

  it('fork hands the collector a session only the app saw continue (history resume)', async () => {
    const r = rig()
    const hw = createHostWorkUnits(r.deps)
    await hw.start()
    await fs.appendFile(t2, wrote())
    hw.fork('s2', t2)
    r.sessions.push({ sessionId: 's2', cwd: project, accountId: 'a1', rolloutPath: null })
    await hw.flush()
    // read from the fork's anchor, not from 0: the replayed conversation opens nothing and marks nothing
    const cursor = onDisk().projects[project].cursors.find((c) => c.sessionId === 's2')
    expect(cursor?.offset).toBe((await fs.stat(t2)).size)
  })
})

describe('workUnitSessionsOf', () => {
  it('lists the live session ptys from their notes, and nothing else', () => {
    const meta = (kind: 'session' | 'terminal' | 'run' | 'chat', id: string, restore: Record<string, unknown>) => ({ kind, id, restore })
    expect(
      workUnitSessionsOf([
        { alive: true, meta: meta('session', 's1', { cwd: 'C:/p', accountId: 'a1' }) },
        { alive: true, meta: meta('session', 's2', { cwd: 'C:/p', accountId: 'c1', rolloutPath: 'C:/r.jsonl' }) },
        { alive: false, meta: meta('session', 's3', { cwd: 'C:/p', accountId: 'a1' }) },
        { alive: true, meta: meta('terminal', 't1', { cwd: 'C:/p' }) },
        { alive: true, meta: meta('session', 's4', { accountId: 'a1' }) },
        { alive: true, meta: null }
      ])
    ).toEqual([
      { sessionId: 's1', cwd: 'C:/p', accountId: 'a1', rolloutPath: null },
      { sessionId: 's2', cwd: 'C:/p', accountId: 'c1', rolloutPath: 'C:/r.jsonl' }
    ])
  })
})

describe('readWorkUnitTracking', () => {
  it('is off with no file, on only for an explicit true, and throws for a file it cannot read', async () => {
    const f = path.join(dir, 'app-settings.json')
    expect(await readWorkUnitTracking(f)).toBe(false)
    await fs.writeFile(f, JSON.stringify({ workUnitTrackingEnabled: true }))
    expect(await readWorkUnitTracking(f)).toBe(true)
    await fs.writeFile(f, JSON.stringify({ workUnitTrackingEnabled: 'yes' }))
    expect(await readWorkUnitTracking(f)).toBe(false)
    await fs.writeFile(f, '{ broken')
    await expect(readWorkUnitTracking(f)).rejects.toThrow()
  })
})

