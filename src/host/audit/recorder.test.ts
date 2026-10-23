// Observe mode's recorder (design §5, §8): every source hands it a finished tool call; it keeps one record per call while
// the mode is observe, resolved to its action and stamped with the session's account, profile and Dispatch, and nothing
// at all in compatibility.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../core/testFixtures'
import { profilePaths } from '../../core/profile/paths'
import { queryRecords } from '../../core/audit/store'
import { emptyState, type OrchState } from '../../core/orchestration/state'
import type { Dispatch, JobRun, Task } from '../../core/orchestration/types'
import type { PtyEntry } from '../../core/host/protocol'
import type { AuditMode } from '../../core/audit/policy'
import { AUDIT_COMMANDS_KEPT, createAuditRecorder, dispatchOfSession, registrySessionFacts, type SessionFacts } from './recorder'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})

const NOW = Date.parse('2026-10-23T03:00:00.000Z')
const cwd = path.resolve('/work/proj')

async function rig(o: { mode?: AuditMode; facts?: SessionFacts | null; dispatch?: { jobId?: string; runId?: string; taskId?: string } | null } = {}) {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-auditrec-'))
  dirs.push(profileDir)
  let mode: AuditMode = o.mode ?? 'observe'
  let modeReads = 0
  const asked: string[] = []
  const logs: string[] = []
  let now = NOW
  const facts: SessionFacts | null = o.facts === undefined ? { kind: 'terminal', accountId: 'acc1', agentProfileId: 'ap1', cwd } : o.facts
  const recorder = createAuditRecorder({
    profileDir,
    mode: async () => {
      modeReads++
      return mode
    },
    sessionInfo: (id) => {
      asked.push(id)
      return facts
    },
    dispatchOf: () => (o.dispatch === undefined ? null : o.dispatch),
    log: (m) => logs.push(m),
    now: () => now
  })
  return {
    profileDir,
    recorder,
    logs,
    asked,
    setMode: (m: AuditMode) => (mode = m),
    modeReads: () => modeReads,
    advance: (msBy: number) => (now += msBy),
    records: () => queryRecords(profileDir, {}),
    folderExists: () => fs.stat(profilePaths(profileDir).auditRecords).then(() => true, () => false)
  }
}

const bash = (command: string, extra: { sessionId?: string; dedupeKey?: string; status?: 'ok' | 'failed' | 'unknown'; at?: string } = {}) => ({
  sessionId: extra.sessionId ?? 'sess_a',
  source: 'claude-hook' as const,
  tool: 'Bash',
  input: { command },
  status: extra.status ?? ('ok' as const),
  ...(extra.dedupeKey !== undefined ? { dedupeKey: extra.dedupeKey } : {}),
  ...(extra.at !== undefined ? { at: extra.at } : {})
})

describe('createAuditRecorder', () => {
  it('drops everything in compatibility: no record, no folder, no session asked', async () => {
    const h = await rig({ mode: 'compatibility' })
    h.recorder.record(bash('git push origin main'))
    h.recorder.record(bash('npm test'))
    await h.recorder.flushed()
    expect(await h.folderExists()).toBe(false)
    expect(h.asked).toEqual([])
  })

  it('keeps one record per call, resolved and stamped with the session and its Dispatch', async () => {
    const h = await rig({ dispatch: { jobId: 'job1', runId: 'run1', taskId: 'task1' } })
    h.recorder.record(bash('git push origin main', { dedupeKey: 'toolu_1' }))
    await h.recorder.flushed()
    const [r] = await h.records()
    expect(r).toEqual({
      id: expect.stringMatching(/^au_[0-9a-f]{16}$/),
      at: new Date(NOW).toISOString(),
      sessionId: 'sess_a',
      provider: 'claude',
      kind: 'terminal',
      accountId: 'acc1',
      agentProfileId: 'ap1',
      jobId: 'job1',
      runId: 'run1',
      taskId: 'task1',
      source: 'claude-hook',
      providerTool: 'Bash',
      action: 'git.remote.write',
      target: 'git push',
      confidence: 'high',
      status: 'ok'
    })
  })

  it('names the provider from the source, keeps the call’s own time, and leaves out what the session does not have', async () => {
    const h = await rig({ facts: { kind: 'chat', accountId: 'acc2', cwd } })
    h.recorder.record({ sessionId: 'sess_c', source: 'codex-chat', tool: 'apply_patch', input: '*** Begin Patch\n*** Add File: ../x.ts\n+a\n*** End Patch', status: 'failed', at: '2026-10-22T10:00:00.000Z' })
    await h.recorder.flushed()
    const [r] = await h.records()
    expect(r).toMatchObject({ provider: 'codex', kind: 'chat', accountId: 'acc2', source: 'codex-chat', providerTool: 'apply_patch', action: 'filesystem.write', insideProject: false, status: 'failed', at: '2026-10-22T10:00:00.000Z' })
    for (const k of ['agentProfileId', 'jobId', 'runId', 'taskId']) expect(r).not.toHaveProperty(k)
  })

  it('keeps every command of a line with its own place, so the rules can judge it later as they would have then', async () => {
    const h = await rig()
    h.recorder.record(bash('rm -rf build && cat ../notes'))
    await h.recorder.flushed()
    const [r] = await h.records()
    expect(r.confidence).toBe('heuristic')
    expect(r.commands).toEqual([
      { action: 'filesystem.delete', insideProject: true },
      { action: 'filesystem.read', insideProject: false }
    ])
  })

  it('keeps at most 16 commands, and a line cut short reads unknown', async () => {
    const h = await rig()
    // The resolver's commands are already without repeats, which today stays under 16 for any line; the cap is the wall
    const commands = Array.from({ length: 20 }, (_, i) => ({ action: 'process.execute' as const, insideProject: i % 2 === 0 }))
    const recorder = createAuditRecorder({
      profileDir: h.profileDir,
      mode: async () => 'observe',
      sessionInfo: () => ({ kind: 'terminal', accountId: 'acc1', cwd }),
      dispatchOf: () => null,
      log: (m) => h.logs.push(m),
      resolve: () => ({ action: 'process.execute', target: 'a', confidence: 'heuristic', commands })
    })
    recorder.record(bash('a && b'))
    await recorder.flushed()
    const [r] = await h.records()
    expect(AUDIT_COMMANDS_KEPT).toBe(16)
    expect(r.commands).toEqual(commands.slice(0, 16))
    expect(r.confidence).toBe('unknown')
  })

  it('keeps no full command, argument past the subcommand or secret', async () => {
    const h = await rig()
    h.recorder.record(bash('curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789" https://api.example.com/v1?key=hunter2'))
    await h.recorder.flushed()
    const text = await fs.readFile(path.join(profilePaths(h.profileDir).auditRecords, (await fs.readdir(profilePaths(h.profileDir).auditRecords))[0]), 'utf8')
    expect(text).not.toMatch(/Bearer|sk-abc|hunter2|api\.example\.com\/v1/)
  })

  it('records a call once per dedupe key within a session', async () => {
    const h = await rig()
    h.recorder.record(bash('git status', { dedupeKey: 'toolu_1' }))
    h.recorder.record(bash('git status', { dedupeKey: 'toolu_1' }))
    h.recorder.record(bash('git status', { dedupeKey: 'toolu_1', sessionId: 'sess_b' }))
    h.recorder.record(bash('git status'))
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect((await h.records()).map((r) => r.sessionId).sort()).toEqual(['sess_a', 'sess_a', 'sess_a', 'sess_b'])
  })

  it('does not observe a session Astera did not start', async () => {
    const h = await rig({ facts: null })
    h.recorder.record(bash('git push'))
    await h.recorder.flushed()
    expect(await h.folderExists()).toBe(false)
  })

  it('reads the mode once a while rather than per call, and again at once when the policies say it changed', async () => {
    const h = await rig({ mode: 'compatibility' })
    for (let i = 0; i < 5; i++) h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(h.modeReads()).toBe(1)
    h.setMode('observe')
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(await h.records()).toHaveLength(0)
    h.recorder.invalidate()
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(await h.records()).toHaveLength(1)
    expect(h.modeReads()).toBe(2)
    // And on its own after a short while
    h.setMode('compatibility')
    h.advance(10_000)
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(await h.records()).toHaveLength(1)
    expect(h.modeReads()).toBe(3)
  })

  it('never throws to a source: a failing lookup is logged and the next call is still recorded', async () => {
    const h = await rig()
    const recorder = createAuditRecorder({
      profileDir: h.profileDir,
      mode: async () => 'observe',
      sessionInfo: (id) => {
        if (id === 'boom') throw new Error('registry gone')
        return { kind: 'terminal', accountId: 'acc1', cwd }
      },
      dispatchOf: () => null,
      log: (m) => h.logs.push(m)
    })
    expect(() => recorder.record(bash('git status', { sessionId: 'boom' }))).not.toThrow()
    recorder.record(bash('git status'))
    await recorder.flushed()
    expect(h.logs.join('\n')).toMatch(/registry gone/)
    expect(await h.records()).toHaveLength(1)
  })
})

describe('registrySessionFacts', () => {
  const entry = (o: Partial<PtyEntry> & { kind?: 'session' | 'chat' | 'terminal'; sid?: string; restore?: Record<string, unknown> }): PtyEntry => ({
    id: o.id ?? 'pty1',
    pid: 1,
    alive: o.alive ?? true,
    meta: { kind: o.kind ?? 'session', id: o.sid ?? 'sess_a', restore: o.restore ?? { accountId: 'acc1', cwd, title: 't', agentProfileId: 'ap1' } }
  })

  it('reads a terminal session from its pty note and a chat from its process note', () => {
    const facts = registrySessionFacts({
      ptys: { list: () => [entry({})] },
      procs: { list: () => [entry({ id: 'proc1', kind: 'chat', sid: 'sess_c', restore: { accountId: 'acc2', cwd, title: 'c' } })] }
    })
    expect(facts('sess_a')).toEqual({ kind: 'terminal', accountId: 'acc1', agentProfileId: 'ap1', cwd })
    expect(facts('sess_c')).toEqual({ kind: 'chat', accountId: 'acc2', cwd })
    expect(facts('sess_x')).toBeNull()
  })

  it('takes the live pty after a roll, ignores a plain shell tab, and a note without its account or folder', () => {
    const facts = registrySessionFacts({
      ptys: {
        list: () => [
          entry({ id: 'old', alive: false, restore: { accountId: 'acc_old', cwd, title: 't' } }),
          entry({ id: 'new', restore: { accountId: 'acc_new', cwd, title: 't' } }),
          entry({ id: 'sh', kind: 'terminal', sid: 'tab1', restore: { cwd } }),
          entry({ id: 'bad', sid: 'sess_bad', restore: { title: 't' } })
        ]
      },
      procs: { list: () => [] }
    })
    expect(facts('sess_a')).toMatchObject({ accountId: 'acc_new' })
    expect(facts('tab1')).toBeNull()
    expect(facts('sess_bad')).toBeNull()
  })
})

describe('dispatchOfSession', () => {
  const state = (dispatches: Array<Partial<Dispatch>>): OrchState => ({
    ...emptyState(),
    runs: [{ id: 'run1', jobId: 'job1' } as JobRun],
    tasks: [{ id: 'task1', runId: 'run1' } as Task, { id: 'task2', runId: 'run1' } as Task],
    dispatches: dispatches as Dispatch[]
  })

  it('names the Job, Run and Task of the session’s open Dispatch, else its latest', () => {
    const s = state([
      { id: 'd1', taskId: 'task1', sessionId: 'sess_a', startedAt: '2026-10-23T01:00:00Z', endedAt: '2026-10-23T02:00:00Z' },
      { id: 'd2', taskId: 'task2', sessionId: 'sess_a', startedAt: '2026-10-23T03:00:00Z' },
      { id: 'd3', taskId: 'task1', sessionId: 'sess_b', startedAt: '2026-10-23T01:00:00Z', endedAt: '2026-10-23T02:00:00Z' },
      { id: 'd4', taskId: 'task2', sessionId: 'sess_b', startedAt: '2026-10-23T00:00:00Z', endedAt: '2026-10-23T00:30:00Z' }
    ])
    expect(dispatchOfSession(s, 'sess_a')).toEqual({ jobId: 'job1', runId: 'run1', taskId: 'task2' })
    expect(dispatchOfSession(s, 'sess_b')).toEqual({ jobId: 'job1', runId: 'run1', taskId: 'task1' })
    expect(dispatchOfSession(s, 'sess_x')).toBeNull()
  })

  it('names what it can find when the Task or Run is gone', () => {
    expect(dispatchOfSession(state([{ id: 'd1', taskId: 'gone', sessionId: 'sess_a', startedAt: '2026-10-23T01:00:00Z' }]), 'sess_a')).toEqual({ taskId: 'gone' })
  })
})
