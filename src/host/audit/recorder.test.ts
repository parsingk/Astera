// Observe mode's recorder (design §5, §8): every source hands it a finished tool call; it keeps one record per call while
// the mode is observe, resolved to its action and stamped with the session's account, profile and Dispatch, and nothing
// at all in compatibility.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../core/testFixtures'
import { profilePaths } from '../../core/profile/paths'
import { appendRecords, auditStoppedAtLimit, queryRecords, type AuditRecord } from '../../core/audit/store'
import { emptyState, type OrchState } from '../../core/orchestration/state'
import type { Dispatch, JobRun, Task } from '../../core/orchestration/types'
import type { PtyEntry } from '../../core/host/protocol'
import type { AuditMode } from '../../core/audit/policy'
import type { ResolvedAction } from '../../core/audit/resolve'
import {
  AUDIT_COMMANDS_KEPT,
  AUDIT_PENDING_MAX,
  createAuditRecorder,
  dispatchOfSession,
  dispatchOfWithTurns,
  registrySessionFacts,
  type SessionFacts,
  type UseEvent
} from './recorder'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})

const NOW = Date.parse('2026-10-23T03:00:00.000Z')
const cwd = path.resolve('/work/proj')

type Deps = Parameters<typeof createAuditRecorder>[0]

async function rig(
  o: { mode?: AuditMode; facts?: SessionFacts | null; dispatch?: { jobId?: string; runId?: string; taskId?: string } | null; over?: Partial<Deps> } = {}
) {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-auditrec-'))
  dirs.push(profileDir)
  let mode: AuditMode = o.mode ?? 'observe'
  let modeReads = 0
  const asked: string[] = []
  const dispatchAsked: Array<[string, string]> = []
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
    dispatchOf: (id, at) => {
      dispatchAsked.push([id, at])
      return o.dispatch === undefined ? null : o.dispatch
    },
    log: (m) => logs.push(m),
    now: () => now,
    ...o.over
  })
  return {
    profileDir,
    recorder,
    logs,
    asked,
    dispatchAsked,
    setMode: (m: AuditMode) => (mode = m),
    modeReads: () => modeReads,
    advance: (msBy: number) => (now += msBy),
    // Read as on the fixtures' day, so the kept days hold them whenever the suite runs
    records: () => queryRecords(profileDir, {}, { now: () => NOW }),
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
    // The mode is read once when the recorder is made
    await h.recorder.flushed()
    h.recorder.record(bash('git push origin main'))
    h.recorder.record(bash('npm test'))
    await h.recorder.flushed()
    expect(await h.folderExists()).toBe(false)
    expect(h.asked).toEqual([])
    expect(h.modeReads()).toBe(1)
  })

  it('holds a call that comes before the mode is known, and drops it without the disk when the mode is compatibility', async () => {
    const h = await rig({ mode: 'compatibility' })
    h.recorder.record(bash('git push origin main'))
    await h.recorder.flushed()
    expect(await h.folderExists()).toBe(false)
  })

  // Enforce records what observe records (enforce design §5)
  it('records calls while the mode is enforce', async () => {
    const h = await rig({ mode: 'enforce' })
    h.recorder.record(bash('git push origin main'))
    await h.recorder.flushed()
    expect((await h.records()).map((r) => r.action)).toEqual(['git.remote.write'])
    expect(h.recorder.observing()).toBe(true)
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
      effect: 'write',
      status: 'ok'
    })
    // The Dispatch is asked at the call's own time
    expect(h.dispatchAsked).toEqual([['sess_a', new Date(NOW).toISOString()]])
  })

  it('names the provider from the source, keeps the call’s own time, and leaves out what the session does not have', async () => {
    const h = await rig({ facts: { kind: 'chat', accountId: 'acc2', cwd } })
    h.recorder.record({ sessionId: 'sess_c', source: 'codex-chat', tool: 'apply_patch', input: '*** Begin Patch\n*** Add File: ../x.ts\n+a\n*** End Patch', status: 'failed', at: '2026-10-22T10:00:00.000Z' })
    await h.recorder.flushed()
    const [r] = await h.records()
    expect(r).toMatchObject({ provider: 'codex', kind: 'chat', accountId: 'acc2', source: 'codex-chat', providerTool: 'apply_patch', action: 'filesystem.write', insideProject: false, status: 'failed', at: '2026-10-22T10:00:00.000Z' })
    for (const k of ['agentProfileId', 'jobId', 'runId', 'taskId']) expect(r).not.toHaveProperty(k)
    expect(h.dispatchAsked).toEqual([['sess_c', '2026-10-22T10:00:00.000Z']])
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
    expect(r).not.toHaveProperty('scripted')
  })

  it('keeps the commands of a loop like any line’s, with no mark that it was a loop', async () => {
    const h = await rig()
    h.recorder.record(bash('for b in a c; do git push origin $b; done'))
    await h.recorder.flushed()
    const [r] = await h.records()
    expect(r).toMatchObject({ action: 'git.remote.write', confidence: 'heuristic', commands: [{ action: 'git.remote.write' }] })
    expect(r).not.toHaveProperty('scripted')
  })

  it('keeps at most 16 commands, and a line cut short reads unknown', async () => {
    // The resolver's commands are already without repeats, which today stays under 16 for any line; the cap is the wall
    const commands = Array.from({ length: 20 }, (_, i) => ({ action: 'process.execute' as const, insideProject: i % 2 === 0 }))
    const h = await rig({ over: { resolve: () => ({ action: 'process.execute', target: 'a', confidence: 'heuristic', commands, effect: 'read' }) } })
    h.recorder.record(bash('a && b'))
    await h.recorder.flushed()
    const [r] = await h.records()
    expect(AUDIT_COMMANDS_KEPT).toBe(16)
    expect(r.commands).toEqual(commands.slice(0, 16))
    expect(r.confidence).toBe('unknown')
    // What was cut may have written (lifecycle design §4.10)
    expect(r.effect).toBe('unknown')
  })

  // Lifecycle design §4.10: whether the call read or wrote, and the login folder it touched by its short name only
  it('a record carries effect and sensitive from the resolver', async () => {
    const h = await rig()
    h.recorder.record(bash('cat ~/.aws/credentials', { dedupeKey: 'a' }))
    h.recorder.record(bash('git push origin main', { dedupeKey: 'b' }))
    await h.recorder.flushed()
    const records = await h.records()
    const read = records.find((r) => r.action === 'filesystem.read')
    const push = records.find((r) => r.action === 'git.remote.write')
    expect(read).toMatchObject({ effect: 'read', sensitive: '.aws' })
    expect(push).toMatchObject({ effect: 'write' })
    expect(push).not.toHaveProperty('sensitive')
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

  // A call of a session it does not observe is not remembered: the same call heard again once the session's note is
  // there (a hook line that came before the note did) is kept.
  it('remembers a call only once it knows the session', async () => {
    let facts: SessionFacts | null = null
    const h = await rig({ over: { sessionInfo: () => facts } })
    h.recorder.record(bash('git status', { dedupeKey: 'toolu_1' }))
    facts = { kind: 'terminal', accountId: 'acc1', cwd }
    h.recorder.record(bash('git status', { dedupeKey: 'toolu_1' }))
    h.recorder.record(bash('git status', { dedupeKey: 'toolu_1' }))
    await h.recorder.flushed()
    expect(await h.records()).toHaveLength(1)
  })

  // The sources ask before they read a file or parse a line (sources.ts): nothing is read while the mode is known to be
  // compatibility, and an unknown mode (not read yet, or just changed) may be observe.
  it('says whether it may be observing', async () => {
    const h = await rig({ mode: 'compatibility' })
    expect(h.recorder.observing()).toBe(true)
    await h.recorder.flushed()
    expect(h.recorder.observing()).toBe(false)
    h.setMode('observe')
    h.recorder.invalidate()
    expect(h.recorder.observing()).toBe(true)
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(h.recorder.observing()).toBe(true)
    // A change back is read at once, with no call to bring it
    h.setMode('compatibility')
    h.recorder.invalidate()
    await h.recorder.flushed()
    expect(h.recorder.observing()).toBe(false)
  })

  // The sources follow the mode from this, not from their next poll (sources.ts): turning observe on must not wait for a
  // timer, or the lines written until it fires are lost
  it('tells its listeners when observing() changes: at once when a change may turn observe on, and when a read says it is off', async () => {
    const h = await rig({ mode: 'compatibility' })
    const seen: boolean[] = []
    const off = h.recorder.onObservingChange(() => seen.push(h.recorder.observing()))
    await h.recorder.flushed()
    expect(seen).toEqual([false])
    h.setMode('observe')
    h.recorder.invalidate()
    // Before the mode is read again: the sources start at the ends as of this moment
    expect(seen).toEqual([false, true])
    await h.recorder.flushed()
    // The read says observe: nothing changed
    expect(seen).toEqual([false, true])
    h.setMode('compatibility')
    h.recorder.invalidate()
    await h.recorder.flushed()
    expect(seen).toEqual([false, true, false])
    // Any change may turn it on until the mode is read again, so a rule edited while it is off is a true and a false
    h.recorder.invalidate()
    await h.recorder.flushed()
    expect(seen).toEqual([false, true, false, true, false])
    // A change that leaves the mode as it was (a rule edited, the starter rules put back) is read again without a word:
    // the sources have nothing to start or stop for it
    h.recorder.invalidate({ modeUnchanged: true })
    expect(h.recorder.observing()).toBe(false)
    await h.recorder.flushed()
    expect(seen).toEqual([false, true, false, true, false])
    expect(h.modeReads()).toBe(5)
    // A listener that left hears nothing
    off()
    h.setMode('observe')
    h.recorder.invalidate()
    await h.recorder.flushed()
    expect(seen).toEqual([false, true, false, true, false])
  })

  it('keeps the mode it read until the policies say it changed', async () => {
    const h = await rig({ mode: 'compatibility' })
    await h.recorder.flushed()
    h.setMode('observe')
    h.advance(24 * 60 * 60 * 1000)
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(await h.records()).toHaveLength(0)
    expect(h.modeReads()).toBe(1)
    h.recorder.invalidate()
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(await h.records()).toHaveLength(1)
    expect(h.modeReads()).toBe(2)
  })

  it('a change that leaves the mode unchanged keeps what it knew while it reads again, and tells of a mode that turned out different', async () => {
    const h = await rig({ mode: 'observe' })
    const seen: boolean[] = []
    h.recorder.onObservingChange(() => seen.push(h.recorder.observing()))
    await h.recorder.flushed()
    expect(h.recorder.observing()).toBe(true)
    h.recorder.invalidate({ modeUnchanged: true })
    expect(h.recorder.observing()).toBe(true)
    h.setMode('compatibility')
    await h.recorder.flushed()
    expect(h.recorder.observing()).toBe(false)
    expect(seen).toEqual([false])
    // Nothing known yet: it is the same as any change
    const fresh = await rig({ mode: 'compatibility' })
    fresh.recorder.invalidate({ modeUnchanged: true })
    expect(fresh.recorder.observing()).toBe(true)
    await fresh.recorder.flushed()
  })

  it('stops the sources while the mode cannot be read, and reads it again on its own: after a pause, backing off, with no change told', async () => {
    let fail = true
    let reads = 0
    const h = await rig({
      over: {
        mode: async () => {
          reads++
          if (fail) throw new Error('audit-policy.json is locked')
          return 'observe'
        }
      }
    })
    const seen: boolean[] = []
    h.recorder.onObservingChange(() => seen.push(h.recorder.observing()))
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(h.recorder.observing()).toBe(false)
    expect(seen).toEqual([false])
    const before = reads
    // The throttle: a tick a second on, or four, reads nothing
    for (const s of [1000, 1000, 1000, 1000]) {
      h.advance(s)
      h.recorder.retryMode()
      await h.recorder.flushed()
    }
    expect(reads).toBe(before)
    // The first retry after five seconds still fails; the next waits twice as long
    h.advance(1000)
    h.recorder.retryMode()
    await h.recorder.flushed()
    expect(reads).toBe(before + 1)
    h.advance(9000)
    h.recorder.retryMode()
    await h.recorder.flushed()
    expect(reads).toBe(before + 1)
    // The wait stops growing at thirty seconds
    h.advance(1000)
    h.recorder.retryMode()
    await h.recorder.flushed()
    expect(reads).toBe(before + 2)
    // 20 s, then 30 s, and 30 s again rather than 40
    for (const [wait, total] of [[20_000, 3], [30_000, 4], [30_000, 5]] as const) {
      h.advance(wait - 1)
      h.recorder.retryMode()
      await h.recorder.flushed()
      expect(reads).toBe(before + total - 1)
      h.advance(1)
      h.recorder.retryMode()
      await h.recorder.flushed()
      expect(reads).toBe(before + total)
    }
    // Said once that it failed, not at every retry
    expect(h.logs.filter((m) => /could not be read/.test(m))).toHaveLength(1)
    // The file is readable again: the next retry resumes the sources and records, with no invalidate
    fail = false
    h.advance(30_000)
    h.recorder.retryMode()
    await h.recorder.flushed()
    expect(h.recorder.observing()).toBe(true)
    expect(seen).toEqual([false, true])
    expect(h.logs.filter((m) => /can be read again/.test(m))).toHaveLength(1)
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(await h.records()).toHaveLength(1)
    // Nothing to retry once it is read: no more reads
    const after = reads
    h.advance(60_000)
    h.recorder.retryMode()
    await h.recorder.flushed()
    expect(reads).toBe(after)
  })

  it('starts the wait over at five seconds when a policies change finds the file still unreadable', async () => {
    let reads = 0
    const h = await rig({
      over: {
        mode: async () => {
          reads++
          throw new Error('audit-policy.json is locked')
        }
      }
    })
    await h.recorder.flushed()
    // Two retries fail, so the wait has grown to twenty seconds
    for (const wait of [5000, 10_000]) {
      h.advance(wait)
      h.recorder.retryMode()
      await h.recorder.flushed()
    }
    // A person's policies changes read it too and fail; they do not grow the wait, they start it over
    for (let i = 0; i < 3; i++) {
      h.recorder.invalidate({ modeUnchanged: true })
      await h.recorder.flushed()
    }
    const before = reads
    h.advance(4999)
    h.recorder.retryMode()
    await h.recorder.flushed()
    expect(reads).toBe(before)
    h.advance(1)
    h.recorder.retryMode()
    await h.recorder.flushed()
    expect(reads).toBe(before + 1)
  })

  it('does not retry a clean compatibility', async () => {
    const h = await rig({ mode: 'compatibility' })
    await h.recorder.flushed()
    const reads = h.modeReads()
    h.advance(60_000)
    h.recorder.retryMode()
    await h.recorder.flushed()
    expect(h.modeReads()).toBe(reads)
  })

  it('does not keep a mode it could not read as observe: sources stop while the file is damaged, and a repair that tells of the change starts them', async () => {
    let fail = true
    const h = await rig({
      over: {
        mode: async () => {
          if (fail) throw new Error('audit-policy.json is damaged')
          return 'observe'
        }
      }
    })
    expect(h.recorder.observing()).toBe(true)
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(await h.folderExists()).toBe(false)
    expect(h.logs.join('\n')).toMatch(/damaged/)
    // The sources have nothing to read while it is damaged, rather than parse every line for the recorder to drop
    expect(h.recorder.observing()).toBe(false)
    fail = false
    h.recorder.invalidate()
    await h.recorder.flushed()
    expect(h.recorder.observing()).toBe(true)
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(await h.records()).toHaveLength(1)
  })

  it('resolves a call while it is handed over, so its input is not held', async () => {
    let resolved = 0
    const h = await rig({ over: { resolve: (): ResolvedAction => (resolved++, { action: 'git.read', target: 'git status', confidence: 'high', effect: 'read' }) } })
    await h.recorder.flushed()
    h.recorder.record(bash('git status'))
    expect(resolved).toBe(1)
    await h.recorder.flushed()
  })

  it('holds at most so many records while the disk does not take them, and counts the rest in the log', async () => {
    let release: () => void = () => {}
    const stuck = new Promise<void>((r) => (release = r))
    const written: AuditRecord[][] = []
    const h = await rig({
      over: {
        resolve: () => ({ action: 'git.read', target: 'git status', confidence: 'high', effect: 'read' }),
        append: async (_dir, recs) => {
          written.push([...recs])
          await stuck
        }
      }
    })
    await h.recorder.flushed()
    // The first goes to the disk and sticks there; the next fill the hold, and three more are dropped
    h.recorder.record(bash('git status'))
    await new Promise((r) => setImmediate(r))
    expect(written.map((w) => w.length)).toEqual([1])
    for (let i = 0; i < AUDIT_PENDING_MAX + 3; i++) h.recorder.record(bash('git status'))
    expect(h.logs.filter((m) => /wait for the disk/.test(m))).toHaveLength(1)
    release()
    await h.recorder.flushed()
    expect(written.map((w) => w.length)).toEqual([1, AUDIT_PENDING_MAX])
    expect(h.logs.join('\n')).toMatch(/3 call\(s\) were not recorded/)
  })

  it('goes on after a write that threw', async () => {
    let calls = 0
    const h = await rig({
      over: {
        append: async () => {
          if (++calls === 1) throw new Error('disk gone')
        }
      }
    })
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(calls).toBe(2)
    expect(h.logs.join('\n')).toMatch(/disk gone/)
  })

  // Deferred minor b: a lookup that turns on which turn the call fell in waits for the session's lines to be read past it
  it('writes a call whose Dispatch lookup has to wait once it settles, with what it found, and with what was known at once when the lookup fails', async () => {
    let settle: (ids: { jobId: string; runId: string } | null) => void = () => {}
    let fail: (err: Error) => void = () => {}
    let n = 0
    const h = await rig({
      over: {
        dispatchOf: () =>
          ++n === 1
            ? { now: null, later: new Promise<{ jobId: string; runId: string } | null>((r) => (settle = r)) }
            : { now: { jobId: 'job_now', runId: 'run_now' }, later: new Promise<null>((_r, j) => (fail = j)) }
      }
    })
    await h.recorder.flushed()
    h.recorder.record(bash('git status', { dedupeKey: 'toolu_1' }))
    await new Promise((r) => setImmediate(r))
    expect(await h.records()).toEqual([])
    settle({ jobId: 'job2', runId: 'run_done' })
    await h.recorder.flushed()
    expect(await h.records()).toMatchObject([{ jobId: 'job2', runId: 'run_done', target: 'git status' }])
    h.recorder.record(bash('npm test', { dedupeKey: 'toolu_2' }))
    await new Promise((r) => setImmediate(r))
    fail(new Error('turns gone'))
    await h.recorder.flushed()
    const records = await h.records()
    expect(records).toHaveLength(2)
    expect(records.find((r) => r.target !== 'git status')).toMatchObject({ jobId: 'job_now', runId: 'run_now' })
    expect(h.logs.join('\n')).toMatch(/turns gone/)
  })

  // Fix round 1, Minor 2: a lookup that never settles holds its record, and every one behind it, only so long; then the
  // record takes what was known at once
  it('writes a call whose lookup never settles after the wait, with what was known at once, and the calls behind it', async () => {
    let n = 0
    const h = await rig({
      over: {
        lookupWaitMs: 30,
        dispatchOf: () => (++n === 1 ? { now: { jobId: 'job_now', runId: 'run_now' }, later: new Promise<null>(() => {}) } : null)
      }
    })
    await h.recorder.flushed()
    h.recorder.record(bash('git status', { dedupeKey: 'toolu_1' }))
    h.recorder.record(bash('npm test', { dedupeKey: 'toolu_2' }))
    await h.recorder.flushed()
    const records = await h.records()
    expect(records).toHaveLength(2)
    expect(records.find((r) => r.target === 'git status')).toMatchObject({ jobId: 'job_now', runId: 'run_now' })
  })

  // A slow token read makes every record's lookup time out: the log says so once per streak, not once per record
  it('logs lookups that time out once per streak, and once when they answer in time again', async () => {
    const answers: Array<'never' | 'now'> = ['never', 'never', 'never', 'now', 'now', 'never']
    let n = 0
    const h = await rig({
      over: {
        lookupWaitMs: 20,
        dispatchOf: () => ({ now: null, later: answers[n++] === 'now' ? Promise.resolve({ jobId: 'job1' }) : new Promise<null>(() => {}) })
      }
    })
    await h.recorder.flushed()
    const late = () => h.logs.filter((m) => /were not read within/.test(m)).length
    const again = () => h.logs.filter((m) => /in time again/.test(m)).length
    for (let i = 0; i < 3; i++) h.recorder.record(bash('git status', { dedupeKey: `toolu_${i}` }))
    await h.recorder.flushed()
    expect([late(), again()]).toEqual([1, 0])
    for (let i = 3; i < 5; i++) h.recorder.record(bash('git status', { dedupeKey: `toolu_${i}` }))
    await h.recorder.flushed()
    expect([late(), again()]).toEqual([1, 1])
    h.recorder.record(bash('git status', { dedupeKey: 'toolu_5' }))
    await h.recorder.flushed()
    expect([late(), again()]).toEqual([2, 1])
    expect(await h.records()).toHaveLength(6)
  })

  // Fix round 1, Minor 7: an ordinary call queued behind one whose lookup waits is written after it, in the order heard
  it('writes an ordinary call queued behind a waiting lookup after it, in order', async () => {
    let settle: (ids: { jobId: string; runId: string } | null) => void = () => {}
    let n = 0
    const written: AuditRecord[][] = []
    const h = await rig({
      over: {
        dispatchOf: () => (++n === 1 ? { now: null, later: new Promise<{ jobId: string; runId: string } | null>((r) => (settle = r)) } : null),
        append: async (_dir, recs) => {
          written.push([...recs])
        }
      }
    })
    await h.recorder.flushed()
    h.recorder.record(bash('git status', { dedupeKey: 'toolu_1' }))
    h.recorder.record(bash('npm test', { dedupeKey: 'toolu_2' }))
    await new Promise((r) => setTimeout(r, 10))
    expect(written).toEqual([])
    settle({ jobId: 'job2', runId: 'run_done' })
    await h.recorder.flushed()
    expect(written.flat().map((r) => [r.target, r.runId])).toEqual([
      ['git status', 'run_done'],
      ['npm test', undefined]
    ])
  })

  // Fix round 1, Minor 1: a call dropped while the hold is full is not looked up, and a lookup whose record was let go
  // (dropped by a change to compatibility before it was written) never rejects unheard
  it('looks up no call it drops, and leaves no lookup of a record it let go rejecting unhandled', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown): void => void unhandled.push(err)
    process.on('unhandledRejection', onUnhandled)
    try {
      let release: () => void = () => {}
      const stuck = new Promise<void>((r) => (release = r))
      let asked = 0
      const h = await rig({
        over: {
          dispatchOf: () => (++asked, { now: null, later: Promise.reject(new Error('turns gone')) }),
          append: async () => {
            await stuck
          }
        }
      })
      await h.recorder.flushed()
      h.recorder.record(bash('git status'))
      await new Promise((r) => setImmediate(r))
      for (let i = 0; i < AUDIT_PENDING_MAX + 3; i++) h.recorder.record(bash('git status'))
      expect(asked).toBe(1 + AUDIT_PENDING_MAX)
      // The mode turns off before the waiting records reach the disk: they are let go unwritten
      h.setMode('compatibility')
      h.recorder.invalidate()
      release()
      await h.recorder.flushed()
      await new Promise((r) => setTimeout(r, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  // A stopped day keeps no record, so its calls cost no resolver and no lookup, which may read the sessions' files
  it('resolves and looks up no call of a day stopped at the size, and still records another day’s', async () => {
    const resolved: unknown[] = []
    const h = await rig({
      dispatch: { jobId: 'job1' },
      over: {
        resolve: (c): ResolvedAction => (resolved.push((c.input as { command: string }).command), { action: 'git.read', target: 'git status', confidence: 'high', effect: 'read' }),
        // The first record alone passes the size, so its day stops
        append: (dir, recs, o) => appendRecords(dir, recs, { ...o, maxBytes: 1, now: () => NOW })
      }
    })
    h.recorder.record(bash('git status', { dedupeKey: 'a' }))
    await h.recorder.flushed()
    expect(auditStoppedAtLimit(h.profileDir)).toBe(true)
    h.recorder.record(bash('git push origin main', { dedupeKey: 'b' }))
    h.recorder.record(bash('npm test', { dedupeKey: 'c', at: new Date(NOW + 24 * 60 * 60 * 1000).toISOString() }))
    await h.recorder.flushed()
    expect(resolved).toEqual(['git status', 'npm test'])
    expect(h.dispatchAsked.map(([, at]) => at)).toEqual([new Date(NOW).toISOString(), new Date(NOW + 24 * 60 * 60 * 1000).toISOString()])
  })

  it('never throws to a source: a failing lookup is logged and the next call is still recorded', async () => {
    const h = await rig({
      over: {
        sessionInfo: (id) => {
          if (id === 'boom') throw new Error('registry gone')
          return { kind: 'terminal', accountId: 'acc1', cwd }
        }
      }
    })
    expect(() => h.recorder.record(bash('git status', { sessionId: 'boom' }))).not.toThrow()
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(h.logs.join('\n')).toMatch(/registry gone/)
    expect(await h.records()).toHaveLength(1)
  })
})

// Lifecycle design §4.12: a use of a skill, command or agent goes to its own log, under the same mode as a call
describe('the recorder’s uses', () => {
  /** Every use written so far, from the use log's day files. */
  const usesIn = async (profileDir: string): Promise<Array<Record<string, unknown>>> => {
    const dir = profilePaths(profileDir).extensionUses
    const names = await fs.readdir(dir).catch(() => [] as string[])
    const out: Array<Record<string, unknown>> = []
    for (const n of names.sort()) for (const l of (await fs.readFile(path.join(dir, n), 'utf8')).split('\n')) if (l !== '') out.push(JSON.parse(l))
    return out
  }
  const skillUse = (over: Partial<UseEvent> = {}): UseEvent => ({ sessionId: 'sess_a', source: 'claude-hook', via: 'skill-tool', name: 'review', ...over })

  it('uses are written while observing and dropped in compatibility', async () => {
    const h = await rig()
    h.recorder.use(skillUse({ dedupeKey: 'toolu_1' }))
    // Heard twice, kept once; the same id as a call is still a use
    h.recorder.use(skillUse({ dedupeKey: 'toolu_1' }))
    h.recorder.record(bash('ls', { dedupeKey: 'toolu_2' }))
    h.recorder.use(skillUse({ via: 'slash', name: 'ship', dedupeKey: 'toolu_2' }))
    await h.recorder.flushed()
    expect((await usesIn(h.profileDir)).map((u) => [u.via, u.name])).toEqual([
      ['skill-tool', 'review'],
      ['slash', 'ship']
    ])
    // Enforce observes too
    const e = await rig({ mode: 'enforce' })
    e.recorder.use(skillUse())
    await e.recorder.flushed()
    expect(await usesIn(e.profileDir)).toHaveLength(1)
    // Compatibility: nothing written, no folder, no session asked
    const c = await rig({ mode: 'compatibility' })
    await c.recorder.flushed()
    c.recorder.use(skillUse())
    await c.recorder.flushed()
    expect(c.asked).toEqual([])
    expect(await fs.stat(profilePaths(c.profileDir).extensionUses).then(() => true, () => false)).toBe(false)
    // Heard before the mode was known to be compatibility: let go without the disk
    const early = await rig({ mode: 'compatibility' })
    early.recorder.use(skillUse())
    await early.recorder.flushed()
    expect(await usesIn(early.profileDir)).toEqual([])
    // Turned off after it was heard: let go too
    const late = await rig()
    late.recorder.use(skillUse())
    late.setMode('compatibility')
    late.recorder.invalidate()
    await late.recorder.flushed()
    expect(await usesIn(late.profileDir)).toEqual([])
  })

  it('a use carries the session’s account and profile', async () => {
    const h = await rig()
    h.recorder.use(skillUse({ via: 'subagent', name: 'Code Reviewer', at: '2026-10-22T10:00:00.000Z' }))
    await h.recorder.flushed()
    expect(await usesIn(h.profileDir)).toEqual([
      {
        id: expect.stringMatching(/^eu_[0-9a-f]{16}$/),
        at: '2026-10-22T10:00:00.000Z',
        sessionId: 'sess_a',
        provider: 'claude',
        kind: 'terminal',
        accountId: 'acc1',
        agentProfileId: 'ap1',
        via: 'subagent',
        name: 'Code Reviewer'
      }
    ])
    // A chat's use, with no profile; a session Astera did not start is not observed
    const chat = await rig({ facts: { kind: 'chat', accountId: 'acc2', cwd } })
    chat.recorder.use(skillUse({ source: 'claude-chat', via: 'agent-tool', name: 'code-reviewer' }))
    await chat.recorder.flushed()
    const [u] = await usesIn(chat.profileDir)
    expect(u).toMatchObject({ kind: 'chat', accountId: 'acc2', via: 'agent-tool', name: 'code-reviewer', at: new Date(NOW).toISOString() })
    expect(u).not.toHaveProperty('agentProfileId')
    const none = await rig({ facts: null })
    none.recorder.use(skillUse())
    await none.recorder.flushed()
    expect(await usesIn(none.profileDir)).toEqual([])
  })
})

describe('registrySessionFacts', () => {
  const entry = (o: Partial<PtyEntry> & { kind?: 'session' | 'chat' | 'terminal'; sid?: string; restore?: Record<string, unknown> }): PtyEntry => ({
    id: o.id ?? 'pty1',
    pid: 1,
    alive: o.alive ?? true,
    meta: { kind: o.kind ?? 'session', id: o.sid ?? 'sess_a', restore: o.restore ?? { accountId: 'acc1', cwd, title: 't', agentProfileId: 'ap1', observed: true } }
  })

  it('reads a terminal session from its pty note and a chat from its process note', () => {
    const facts = registrySessionFacts({
      ptys: { list: () => [entry({})] },
      procs: { list: () => [entry({ id: 'proc1', kind: 'chat', sid: 'sess_c', restore: { accountId: 'acc2', cwd, title: 'c', observed: true } })] }
    })
    expect(facts('sess_a')).toEqual({ kind: 'terminal', accountId: 'acc1', agentProfileId: 'ap1', cwd })
    expect(facts('sess_c')).toEqual({ kind: 'chat', accountId: 'acc2', cwd })
    expect(facts('sess_x')).toBeNull()
  })

  it('takes the live pty after a roll, ignores a plain shell tab, and a note without its account or folder', () => {
    const facts = registrySessionFacts({
      ptys: {
        list: () => [
          entry({ id: 'old', alive: false, restore: { accountId: 'acc_old', cwd, title: 't', observed: true } }),
          entry({ id: 'new', restore: { accountId: 'acc_new', cwd, title: 't', observed: true } }),
          entry({ id: 'sh', kind: 'terminal', sid: 'tab1', restore: { cwd, observed: true } }),
          entry({ id: 'bad', sid: 'sess_bad', restore: { title: 't', observed: true } })
        ]
      },
      procs: { list: () => [] }
    })
    expect(facts('sess_a')).toMatchObject({ accountId: 'acc_new' })
    expect(facts('tab1')).toBeNull()
    expect(facts('sess_bad')).toBeNull()
  })

  // Review Focus 1: a session started while the mode was compatibility keeps its hooks and is not observed, though the
  // mode is observe now; its note carries no mark, and its calls are not kept from any source.
  it('is null for a session whose note does not say it was started observed', () => {
    const facts = registrySessionFacts({
      ptys: { list: () => [entry({ restore: { accountId: 'acc1', cwd, title: 't' } })] },
      procs: { list: () => [entry({ id: 'proc1', kind: 'chat', sid: 'sess_c', restore: { accountId: 'acc2', cwd, title: 'c', observed: 'yes' } })] }
    })
    expect(facts('sess_a')).toBeNull()
    expect(facts('sess_c')).toBeNull()
  })
})

describe('dispatchOfSession', () => {
  const state = (dispatches: Array<Partial<Dispatch>>, runs: Array<Partial<JobRun>> = [{ id: 'run1', jobId: 'job1' }], tasks: Array<Partial<Task>> = []): OrchState => ({
    ...emptyState(),
    runs: runs as JobRun[],
    tasks: [{ id: 'task1', runId: 'run1' } as Task, { id: 'task2', runId: 'run1' } as Task, ...(tasks as Task[])],
    dispatches: dispatches as Dispatch[]
  })
  const T = (hhmm: string): string => `2026-10-23T${hhmm}:00.000Z`

  it('names the Job, Run and Task of the Dispatch whose time holds the call', () => {
    const s = state([
      { id: 'd1', taskId: 'task1', sessionId: 'sess_a', startedAt: T('01:00'), endedAt: T('02:00') },
      { id: 'd2', taskId: 'task2', sessionId: 'sess_a', startedAt: T('03:00') }
    ])
    expect(dispatchOfSession(s, 'sess_a', T('01:30'))).toEqual({ jobId: 'job1', runId: 'run1', taskId: 'task1' })
    expect(dispatchOfSession(s, 'sess_a', T('03:30'))).toEqual({ jobId: 'job1', runId: 'run1', taskId: 'task2' })
    expect(dispatchOfSession(s, 'sess_x', T('03:30'))).toBeNull()
  })

  // Final review I2: the worker's own last calls (its report) land just after its Dispatch ends; a tab a worker was typed
  // into goes on long after, and that is not the Task's work
  it('takes the Dispatch that ended last for a call within two minutes of its end, and none after', () => {
    const s = state([
      { id: 'd1', taskId: 'task1', sessionId: 'sess_b', startedAt: T('01:00'), endedAt: T('02:00') },
      { id: 'd2', taskId: 'task2', sessionId: 'sess_b', startedAt: T('00:00'), endedAt: T('00:30') }
    ])
    expect(dispatchOfSession(s, 'sess_b', '2026-10-23T02:01:59.000Z')).toEqual({ jobId: 'job1', runId: 'run1', taskId: 'task1' })
    expect(dispatchOfSession(s, 'sess_b', '2026-10-23T02:02:00.000Z')).toEqual({ jobId: 'job1', runId: 'run1', taskId: 'task1' })
    expect(dispatchOfSession(s, 'sess_b', '2026-10-23T02:02:01.000Z')).toBeNull()
    expect(dispatchOfSession(s, 'sess_b', T('02:10'))).toBeNull()
    // Between two Dispatches, the earlier one's window only
    expect(dispatchOfSession(s, 'sess_b', '2026-10-23T00:31:00.000Z')).toEqual({ jobId: 'job1', runId: 'run1', taskId: 'task2' })
    expect(dispatchOfSession(s, 'sess_b', T('00:45'))).toBeNull()
  })

  // Deferred minor c: a worker's last calls inside the turn that was running when its Dispatch ended keep its Task
  // however late they come; a prompt typed into the tab after the end begins a turn that is nobody's Task
  it('takes an ended Dispatch for a call in the turn running at its end, however late, and none for a turn begun after', () => {
    const s = state([{ id: 'd1', taskId: 'task1', sessionId: 'sess_b', startedAt: T('01:00'), endedAt: T('02:00') }])
    const began = (at: string) => () => Date.parse(at)
    expect(dispatchOfSession(s, 'sess_b', T('02:03'), began(T('01:30')))).toEqual({ jobId: 'job1', runId: 'run1', taskId: 'task1' })
    expect(dispatchOfSession(s, 'sess_b', '2026-10-23T02:01:30.000Z', began(T('02:01')))).toBeNull()
  })

  it('falls to the coordinator slot once the ended Dispatch’s window has passed', () => {
    const s = state(
      [{ id: 'd1', taskId: 'task1', sessionId: 'sess_co', startedAt: T('01:00'), endedAt: T('02:00') }],
      [
        { id: 'run1', jobId: 'job1', createdAt: T('00:00') },
        { id: 'run2', jobId: 'job2', createdAt: T('00:00'), coordinatorSessionId: 'sess_co' }
      ]
    )
    expect(dispatchOfSession(s, 'sess_co', T('02:01'))).toEqual({ jobId: 'job1', runId: 'run1', taskId: 'task1' })
    expect(dispatchOfSession(s, 'sess_co', T('02:10'))).toEqual({ jobId: 'job2', runId: 'run2' })
  })

  it('names what it can find when the Task or Run is gone', () => {
    expect(dispatchOfSession(state([{ id: 'd1', taskId: 'gone', sessionId: 'sess_a', startedAt: T('01:00') }]), 'sess_a', T('01:30'))).toEqual({ taskId: 'gone' })
  })

  it('names a coordinator’s Run and Job, the unfinished Run first, else the latest', () => {
    const runs: Array<Partial<JobRun>> = [
      { id: 'run_old', jobId: 'job1', createdAt: T('00:00'), coordinatorSessionId: 'sess_co' },
      { id: 'run_live', jobId: 'job1', createdAt: T('01:00'), coordinatorSessionId: 'sess_co' },
      { id: 'run_done', jobId: 'job2', createdAt: T('02:00'), coordinatorSessionId: 'sess_co' },
      { id: 'run_ext', jobId: 'job3', createdAt: T('02:00'), externalCoordinatorSessionId: 'sess_ext' }
    ]
    // run_live has a Task at work; run_old's and run_done's only Tasks are complete
    const tasks: Array<Partial<Task>> = [
      { id: 't_live', runId: 'run_live', status: 'dispatched' },
      { id: 't_done', runId: 'run_done', status: 'completed' },
      { id: 't_old', runId: 'run_old', status: 'completed' }
    ]
    expect(dispatchOfSession(state([], runs, tasks), 'sess_co', T('03:00'))).toEqual({ jobId: 'job1', runId: 'run_live' })
    // All finished: the latest whose bound holds the call
    const finished = tasks.map((t) => ({ ...t, status: 'completed' as const, updatedAt: T('02:59') }))
    expect(dispatchOfSession(state([], runs, finished), 'sess_co', T('03:00'))).toEqual({ jobId: 'job2', runId: 'run_done' })
    // A session that drives a Run from outside is not its coordinator here
    expect(dispatchOfSession(state([], runs, tasks), 'sess_ext', T('03:00'))).toBeNull()
  })

  // Deferred minor b: a finished Run's coordinator tab files its calls under the Run up to the end of the turn that was
  // running when the Run's outcome became final (its `endedAt`); a tab reused after that, minutes or days later, is
  // nobody's Run, and a Task edited after the end opens nothing
  it('names a finished Run’s coordinator only up to the end of the turn running when the Run finished', () => {
    const runs: Array<Partial<JobRun>> = [{ id: 'run_done', jobId: 'job2', createdAt: T('00:00'), coordinatorSessionId: 'sess_co', endedAt: T('02:00') }]
    const tasks: Array<Partial<Task>> = [{ id: 't_done', runId: 'run_done', status: 'completed', updatedAt: T('05:00') }]
    const s = state([], runs, tasks)
    const began = (at: string) => () => Date.parse(at)
    const ids = { jobId: 'job2', runId: 'run_done' }
    expect(dispatchOfSession(s, 'sess_co', T('01:59'))).toEqual(ids)
    // The wrap-up ten minutes on, inside the turn that began before the end
    expect(dispatchOfSession(s, 'sess_co', T('02:10'), began(T('01:30')))).toEqual(ids)
    // Reused after that turn
    expect(dispatchOfSession(s, 'sess_co', T('02:30'), began(T('02:20')))).toBeNull()
    expect(dispatchOfSession(s, 'sess_co', '2026-10-26T09:00:00.000Z', began('2026-10-26T08:59:00.000Z'))).toBeNull()
    // Turns the session's lines cannot tell: two minutes after the end, not after the edit
    expect(dispatchOfSession(s, 'sess_co', '2026-10-23T02:02:00.000Z')).toEqual(ids)
    expect(dispatchOfSession(s, 'sess_co', T('02:03'))).toBeNull()
    expect(dispatchOfSession(s, 'sess_co', T('05:01'))).toBeNull()
  })

  it('asks the turn only for a call past an end', () => {
    const runs: Array<Partial<JobRun>> = [{ id: 'run_done', jobId: 'job2', createdAt: T('00:00'), coordinatorSessionId: 'sess_co', endedAt: T('02:00') }]
    const s = state([{ id: 'd1', taskId: 'task1', sessionId: 'sess_w', startedAt: T('01:00') }], runs, [{ id: 't_done', runId: 'run_done', status: 'completed' }])
    let asked = 0
    const turn = () => (asked++, null)
    dispatchOfSession(s, 'sess_co', T('01:30'), turn)
    dispatchOfSession(s, 'sess_w', T('01:30'), turn)
    expect(asked).toBe(0)
    dispatchOfSession(s, 'sess_co', T('02:30'), turn)
    expect(asked).toBe(1)
  })

  it('takes a Dispatch over a coordinator slot', () => {
    const s = state([{ id: 'd1', taskId: 'task1', sessionId: 'sess_co', startedAt: T('01:00') }], [
      { id: 'run1', jobId: 'job1', createdAt: T('00:00') },
      { id: 'run2', jobId: 'job2', createdAt: T('00:00'), coordinatorSessionId: 'sess_co' }
    ])
    expect(dispatchOfSession(s, 'sess_co', T('01:30'))).toEqual({ jobId: 'job1', runId: 'run1', taskId: 'task1' })
  })
})

// The recorder's lookup as the Host wires it (index.ts): the token sources read each session's own lines and tell its
// turns, a few seconds behind the call the audit hears at once
describe('dispatchOfWithTurns', () => {
  const T = (hhmm: string): string => `2026-10-23T${hhmm}:00.000Z`
  const s: OrchState = {
    ...emptyState(),
    runs: [{ id: 'run_done', jobId: 'job2', ordinal: 1, createdAt: T('00:00'), coordinatorSessionId: 'sess_co', endedAt: T('02:00') }],
    tasks: [{ id: 't_done', runId: 'run_done', status: 'completed', consecutiveFailures: 0 } as Task]
  }
  const ids = { jobId: 'job2', runId: 'run_done' }

  it('answers at once when no turn was asked, and when the session was read past the call', () => {
    let reads = 0
    const of = dispatchOfWithTurns(() => s, { turnOf: () => Date.parse(T('01:30')), readPast: () => (reads++, null) })
    expect(of('sess_co', T('01:00'))).toEqual(ids)
    expect(reads).toBe(0)
    expect(of('sess_co', T('02:10'))).toEqual(ids)
    expect(reads).toBe(1)
  })

  // A read can only find later starts, so a turn known to have begun after the end stays after it: a tab used on long
  // after does not read every session's files at each of its calls
  it('answers at once a call whose turn is known to have begun after the end', () => {
    let reads = 0
    const of = dispatchOfWithTurns(() => s, { turnOf: () => Date.parse(T('02:20')), readPast: () => (reads++, Promise.resolve()) })
    expect(of('sess_co', T('02:30'))).toBeNull()
    expect(reads).toBe(0)
  })

  it('waits for a read past the call when the answer turned on a turn, and answers from what that read found', async () => {
    // Read so far: the turn that was running at the end. The read past the call finds a prompt typed after it
    let turn = Date.parse(T('01:30'))
    let read: () => void = () => {}
    const of = dispatchOfWithTurns(() => s, {
      turnOf: () => turn,
      readPast: () =>
        new Promise<void>((r) => {
          read = () => {
            turn = Date.parse(T('02:20'))
            r()
          }
        })
    })
    // What is known at once goes with it, for a read that never ends (Minor 2)
    const deferred = of('sess_co', T('02:30')) as { now: unknown; later: Promise<unknown> }
    expect(deferred.now).toEqual(ids)
    read()
    expect(await deferred.later).toBeNull()
  })

  // Fix round 1, Minor 3: a read can change only an answer that turned on the turn. An ended Dispatch past its end asks
  // the turn, and a turn known to have begun after that end leaves the answer to the unfinished Run, which no read moves
  it('answers at once when the answer is an unfinished Run’s, though an ended Dispatch asked the turn', () => {
    const live: OrchState = {
      ...emptyState(),
      runs: [{ id: 'run_live', jobId: 'job1', ordinal: 1, createdAt: T('00:00'), coordinatorSessionId: 'sess_co' }],
      tasks: [{ id: 't_live', runId: 'run_live', status: 'dispatched', consecutiveFailures: 0 } as Task],
      dispatches: [{ id: 'd1', taskId: 't_live', sessionId: 'sess_co', startedAt: T('00:10'), endedAt: T('01:00') } as Dispatch]
    }
    let reads = 0
    const of = dispatchOfWithTurns(() => live, { turnOf: () => Date.parse(T('01:30')), readPast: () => (reads++, Promise.resolve()) })
    expect(of('sess_co', T('02:00'))).toEqual({ jobId: 'job1', runId: 'run_live' })
    expect(reads).toBe(0)
  })
})

// Enforce (enforce design §5, E5): a blocked call is kept as the hook resolved it, once; and a session started in
// Enforce whose calls come with no proof that its hook ran is stopped
describe('the recorder in Enforce', () => {
  const ENFORCED: SessionFacts = { kind: 'terminal', accountId: 'acc1', cwd, enforced: true }
  const blockedEv = {
    sessionId: 's1', source: 'claude-hook' as const, tool: 'Bash', input: {}, status: 'blocked' as const, blockedBy: 'starter-git-remote-write',
    dedupeKey: 'toolu_2', resolved: { action: 'git.remote.write' as const, target: 'git push', confidence: 'high' as const }
  }

  it('keeps a blocked call once though the provider reports it too', async () => {
    const resolved: string[] = []
    const r = await rig({ mode: 'enforce', facts: ENFORCED, over: { hookRan: () => true, resolve: (c) => (resolved.push(c.tool), { action: 'other', target: c.tool, confidence: 'unknown', effect: 'unknown' }) } })
    r.recorder.record(blockedEv)
    r.recorder.record({ sessionId: 's1', source: 'claude-chat', tool: 'Bash', input: { command: 'git push' }, status: 'failed', dedupeKey: 'toolu_2' })
    await r.recorder.flushed()
    const records = await r.records()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ status: 'blocked', blockedBy: 'starter-git-remote-write', action: 'git.remote.write', target: 'git push', confidence: 'high', source: 'claude-hook' })
    // The hook resolved it: the resolver is not asked again
    expect(resolved).toEqual([])
  })

  // Lifecycle design §4.10: a hook of an earlier release wrote no effect, and the record does not guess one
  it('a blocked call from an Enforce line without effect is recorded without it', async () => {
    const r = await rig({ mode: 'enforce', facts: ENFORCED, over: { hookRan: () => true } })
    r.recorder.record(blockedEv)
    await r.recorder.flushed()
    const [rec] = await r.records()
    expect(rec).toMatchObject({ status: 'blocked', action: 'git.remote.write' })
    expect(rec).not.toHaveProperty('effect')
    expect(rec).not.toHaveProperty('sensitive')
  })

  it('a blocked call from an Enforce line with effect keeps it, and the login folder it names', async () => {
    const r = await rig({ mode: 'enforce', facts: ENFORCED, over: { hookRan: () => true } })
    r.recorder.record({ ...blockedEv, resolved: { action: 'filesystem.read', target: 'outside project: id_rsa', confidence: 'high', insideProject: false, effect: 'read', sensitive: '.ssh' } })
    await r.recorder.flushed()
    const [rec] = await r.records()
    expect(rec).toMatchObject({ status: 'blocked', action: 'filesystem.read', insideProject: false, effect: 'read', sensitive: '.ssh' })
  })

  it('stops an enforced session whose calls arrive with no proof, once', async () => {
    const missing: string[] = []
    let proof = false
    const r = await rig({ mode: 'enforce', facts: ENFORCED, over: { hookRan: () => proof, onHookMissing: (id) => void missing.push(id) } })
    const call = (key: string) => ({ sessionId: 's1', source: 'claude-hook' as const, tool: 'Bash', input: { command: 'npm test' }, status: 'ok' as const, dedupeKey: key })
    r.recorder.record(call('a'))
    r.recorder.record(call('b'))
    expect(missing).toEqual(['s1'])
    // A blocked call is the proof itself, and a session with its proof is left alone
    proof = true
    r.recorder.record(call('c'))
    expect(missing).toEqual(['s1'])
    await r.recorder.flushed()
  })

  it('does not ask a session started before Enforce for the proof', async () => {
    const asked: string[] = []
    const missing: string[] = []
    const r = await rig({ mode: 'enforce', facts: { kind: 'terminal', accountId: 'acc1', cwd }, over: { hookRan: (id) => (asked.push(id), false), onHookMissing: (id) => void missing.push(id) } })
    r.recorder.record({ sessionId: 's1', source: 'claude-hook', tool: 'Bash', input: { command: 'npm test' }, status: 'ok', dedupeKey: 'a' })
    await r.recorder.flushed()
    expect(asked).toEqual([])
    expect(missing).toEqual([])
    expect(await r.records()).toHaveLength(1)
  })

  it('does not count a quiet tool or a hosted web search as a call that needed the hook', async () => {
    const missing: string[] = []
    const r = await rig({ mode: 'enforce', facts: ENFORCED, over: { hookRan: () => false, onHookMissing: (id) => void missing.push(id) } })
    r.recorder.record({ sessionId: 's1', source: 'claude-hook', tool: 'TodoWrite', input: {}, status: 'ok', dedupeKey: 'a' })
    r.recorder.record({ sessionId: 's1', source: 'codex-rollout', tool: 'web_search_call', input: {}, status: 'ok', dedupeKey: 'b' })
    r.recorder.record({ sessionId: 's1', source: 'claude-chat', tool: 'WebSearch', input: { query: 'x' }, status: 'ok', dedupeKey: 'c' })
    expect(missing).toEqual([])
    r.recorder.record({ sessionId: 's1', source: 'codex-rollout', tool: 'shell_command', input: { command: 'git status' }, status: 'ok', dedupeKey: 'd' })
    expect(missing).toEqual(['s1'])
    await r.recorder.flushed()
  })

  // Final review I5a: a call read before it ran (a Codex rollout's MCP call, handed at once) may come before its hook did
  it('asks for the proof only of a call that ran', async () => {
    const missing: string[] = []
    const r = await rig({ mode: 'enforce', facts: ENFORCED, over: { hookRan: () => false, onHookMissing: (id) => void missing.push(id) } })
    r.recorder.record({ sessionId: 's1', source: 'codex-rollout', tool: 'mcp__gh__create_issue', input: {}, status: 'unknown', dedupeKey: 'a' })
    expect(missing).toEqual([])
    r.recorder.record({ sessionId: 's1', source: 'codex-rollout', tool: 'mcp__gh__create_issue', input: {}, status: 'ok', dedupeKey: 'b' })
    expect(missing).toEqual(['s1'])
    await r.recorder.flushed()
  })

  // Final review I4: a call of a Claude session that its hook's file has no line for, told by the sources
  it('stops a session the sources say ran a call unhooked, once', async () => {
    const missing: string[] = []
    const r = await rig({ mode: 'enforce', facts: ENFORCED, over: { hookRan: () => true, onHookMissing: (id) => void missing.push(id) } })
    r.recorder.unhooked('s1')
    r.recorder.unhooked('s1')
    expect(missing).toEqual(['s1'])
    // Nothing for a session not started in Enforce
    const o = await rig({ mode: 'enforce', facts: { kind: 'terminal', accountId: 'acc1', cwd }, over: { onHookMissing: (id) => void missing.push(id) } })
    o.recorder.unhooked('s2')
    expect(missing).toEqual(['s1'])
  })

  // Final review I7: a session started in Enforce keeps blocking after the person turns the mode off, and its blocks
  // are what tell them why their agent is still refused
  it('keeps the blocks of a session started in Enforce after the mode is turned off, and nothing else', async () => {
    const r = await rig({ mode: 'compatibility', facts: ENFORCED })
    r.recorder.record(blockedEv)
    r.recorder.record({ sessionId: 's1', source: 'claude-hook', tool: 'Read', input: { file_path: 'a' }, status: 'ok', dedupeKey: 'r1' })
    await r.recorder.flushed()
    expect((await r.records()).map((x) => x.status)).toEqual(['blocked'])
    const o = await rig({ mode: 'compatibility', facts: { kind: 'terminal', accountId: 'acc1', cwd } })
    o.recorder.record(blockedEv)
    await o.recorder.flushed()
    expect(await o.records()).toEqual([])
  })

  it('reads a note’s enforced mark into the session’s facts', () => {
    const facts = registrySessionFacts({
      ptys: { list: () => [{ id: 'p1', pid: 1, alive: true, meta: { kind: 'session', id: 's1', restore: { accountId: 'acc1', cwd, observed: true, enforced: true } } }] },
      procs: { list: () => [{ id: 'c1', pid: 2, alive: true, meta: { kind: 'chat', id: 's2', restore: { accountId: 'acc1', cwd, observed: true } } }] }
    })
    expect(facts('s1')).toMatchObject({ enforced: true })
    expect(facts('s2')).not.toHaveProperty('enforced')
  })
})
