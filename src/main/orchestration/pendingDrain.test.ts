import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readPendingReports, applyPendingReports, MAX_APPLY_ATTEMPTS } from './pendingDrain'
import {
  pendingReportFileName,
  pendingReportTempName,
  parsePendingReport,
  serializePendingReport,
  type PendingReport
} from '../../core/orchestration/pendingReports'
import { OrchestrationStore } from './store'
import { applyWorkerDone, emptyState, type OrchState } from '../../core/orchestration/state'
import { candidates } from '../recovery/reconciler'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-drain-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const report = (dispatchId: string): PendingReport => ({
  queuedAt: '2026-09-10T01:02:03.004Z',
  sessionId: `sess_${dispatchId}`,
  cmd: 'send',
  args: { type: 'worker_done', taskId: 't', dispatchId, outcome: 'succeeded' }
})

const queue = async (a: {
  at: string
  nonce: string
  dispatchId: string
  attempts?: number
}): Promise<string> => {
  await fs.mkdir(dir, { recursive: true })
  const name = pendingReportFileName({ queuedAt: a.at, nonce: a.nonce })
  await fs.writeFile(
    path.join(dir, name),
    serializePendingReport({
      ...report(a.dispatchId),
      queuedAt: a.at,
      ...(a.attempts === undefined ? {} : { attempts: a.attempts })
    }),
    'utf8'
  )
  return name
}

const files = async (): Promise<string[]> => (await fs.readdir(dir).catch(() => [])).sort()

describe('readPendingReports', () => {
  it('finds nothing when no worker ever queued anything', async () => {
    expect(await readPendingReports({ dir: path.join(dir, 'never-made'), log: () => {} })).toEqual([])
  })

  it('reads them back in the order they were attempted', async () => {
    await queue({ at: '2026-09-10T03:00:00.000Z', nonce: 'aaaaaaaa', dispatchId: 'dsp_late' })
    await queue({ at: '2026-09-10T01:00:00.000Z', nonce: 'ffffffff', dispatchId: 'dsp_early' })
    const got = await readPendingReports({ dir, log: () => {} })
    expect(got.map((q) => q.report.args.dispatchId)).toEqual(['dsp_early', 'dsp_late'])
  })

  // A report it cannot read is not a report it knows is worthless. It goes out of the way under a
  // name the reader will not pick up again -- so it stops being retried and stops holding anything
  // open -- but it stays on disk for a person to look at.
  it('sets aside a file it cannot read, and says so, rather than deleting it', async () => {
    await queue({ at: '2026-09-10T01:00:00.000Z', nonce: 'aaaaaaaa', dispatchId: 'dsp_1' })
    await fs.writeFile(path.join(dir, '2026-09-10T020000000Z-bbbbbbbb.json'), '{half writ', 'utf8')
    const said: string[] = []
    const got = await readPendingReports({ dir, log: (m) => said.push(m) })
    expect(got).toHaveLength(1)
    expect(await files()).toEqual([
      '2026-09-10T010000000Z-aaaaaaaa.json',
      '2026-09-10T020000000Z-bbbbbbbb.json.unreadable'
    ])
    expect(said.join(' ')).toContain('bbbbbbbb')
  })

  it('does not pick a set-aside file up again at the next start', async () => {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, '2026-09-10T020000000Z-bbbbbbbb.json.unreadable'), '{half', 'utf8')
    const said: string[] = []
    expect(await readPendingReports({ dir, log: (m) => said.push(m) })).toEqual([])
    expect(said).toEqual([])
  })

  // A worker writing its report at the moment the app boots is exactly the case this path is for.
  // The CLI renames into place, so a torn write is only ever visible under the temporary name.
  it('ignores the temporary file of a write that has not landed yet', async () => {
    await queue({ at: '2026-09-10T01:00:00.000Z', nonce: 'aaaaaaaa', dispatchId: 'dsp_1' })
    // The name the CLI writes under, not a literal: change the suffix to something ending in
    // .json and this is where it shows up.
    const tmp = pendingReportTempName(
      pendingReportFileName({ queuedAt: '2026-09-10T02:00:00.000Z', nonce: 'bbbbbbbb' })
    )
    await fs.writeFile(path.join(dir, tmp), '{half writ', 'utf8')
    const said: string[] = []
    expect(await readPendingReports({ dir, log: (m) => said.push(m) })).toHaveLength(1)
    expect(await files()).toContain(tmp)
    expect(said).toEqual([])
  })

  it('ignores anything that is not a report file', async () => {
    await queue({ at: '2026-09-10T01:00:00.000Z', nonce: 'aaaaaaaa', dispatchId: 'dsp_1' })
    await fs.writeFile(path.join(dir, 'notes.txt'), 'hello', 'utf8')
    expect(await readPendingReports({ dir, log: () => {} })).toHaveLength(1)
    expect(await files()).toContain('notes.txt')
  })
})

describe('applyPendingReports', () => {
  it('applies each report and clears its file', async () => {
    await queue({ at: '2026-09-10T01:00:00.000Z', nonce: 'aaaaaaaa', dispatchId: 'dsp_1' })
    await queue({ at: '2026-09-10T02:00:00.000Z', nonce: 'bbbbbbbb', dispatchId: 'dsp_2' })
    const seen: string[] = []
    const r = await applyPendingReports({
      queued: await readPendingReports({ dir, log: () => {} }),
      apply: async (rep) => {
        seen.push(String(rep.args.dispatchId))
        return { ok: true, detail: 'accepted' }
      },
      log: () => {}
    })
    expect(seen).toEqual(['dsp_1', 'dsp_2'])
    expect(r).toEqual({ applied: 2, rejected: 0, kept: 0, gaveUp: 0 })
    expect(await files()).toEqual([])
  })

  it('clears a report the app refuses, and the ones behind it still go in', async () => {
    await queue({ at: '2026-09-10T01:00:00.000Z', nonce: 'aaaaaaaa', dispatchId: 'dsp_gone' })
    await queue({ at: '2026-09-10T02:00:00.000Z', nonce: 'bbbbbbbb', dispatchId: 'dsp_2' })
    const said: string[] = []
    const r = await applyPendingReports({
      queued: await readPendingReports({ dir, log: () => {} }),
      apply: async (rep) =>
        rep.args.dispatchId === 'dsp_gone'
          ? { ok: false, detail: 'unknown dispatch: dsp_gone' }
          : { ok: true, detail: 'accepted' },
      log: (m) => said.push(m)
    })
    expect(r).toEqual({ applied: 1, rejected: 1, kept: 0, gaveUp: 0 })
    expect(await files()).toEqual([])
    // The rejection is the only record left of what that worker said, so it has to carry it.
    expect(said.join(' ')).toContain('unknown dispatch: dsp_gone')
  })

  it('keeps a report whose application threw, so the next start can try again', async () => {
    await queue({ at: '2026-09-10T01:00:00.000Z', nonce: 'aaaaaaaa', dispatchId: 'dsp_boom' })
    await queue({ at: '2026-09-10T02:00:00.000Z', nonce: 'bbbbbbbb', dispatchId: 'dsp_2' })
    const said: string[] = []
    const r = await applyPendingReports({
      queued: await readPendingReports({ dir, log: () => {} }),
      apply: async (rep) => {
        if (rep.args.dispatchId === 'dsp_boom') throw new Error('disk on fire')
        return { ok: true, detail: 'accepted' }
      },
      log: (m) => said.push(m)
    })
    expect(r).toEqual({ applied: 1, rejected: 0, kept: 1, gaveUp: 0 })
    expect(await files()).toEqual(['2026-09-10T010000000Z-aaaaaaaa.json'])
    expect(said.join(' ')).toContain('disk on fire')
  })

  // Keeping a report whose application threw is right once. Kept forever it is the one shape in
  // this design with no way back: the Dispatch is held open at every boot, the Task never moves,
  // and nobody can see why.
  it('counts the attempt on the report itself, so the count survives the restart', async () => {
    await queue({ at: '2026-09-10T01:00:00.000Z', nonce: 'aaaaaaaa', dispatchId: 'dsp_boom' })
    const r = await applyPendingReports({
      queued: await readPendingReports({ dir, log: () => {} }),
      apply: async () => {
        throw new Error('disk on fire')
      },
      log: () => {}
    })
    expect(r.kept).toBe(1)
    const left = await files()
    expect(left).toEqual(['2026-09-10T010000000Z-aaaaaaaa.json'])
    expect(
      parsePendingReport(await fs.readFile(path.join(dir, left[0]), 'utf8'))?.attempts
    ).toBe(1)
  })

  it('gives up on the last attempt, so the Dispatch stops being held open', async () => {
    await queue({
      at: '2026-09-10T01:00:00.000Z',
      nonce: 'aaaaaaaa',
      dispatchId: 'dsp_boom',
      attempts: MAX_APPLY_ATTEMPTS - 1
    })
    await queue({ at: '2026-09-10T02:00:00.000Z', nonce: 'bbbbbbbb', dispatchId: 'dsp_2' })
    const said: string[] = []
    const r = await applyPendingReports({
      queued: await readPendingReports({ dir, log: () => {} }),
      apply: async (rep) => {
        if (rep.args.dispatchId === 'dsp_boom') throw new Error('disk on fire')
        return { ok: true, detail: 'accepted' }
      },
      log: (m) => said.push(m)
    })
    expect(r).toEqual({ applied: 1, rejected: 0, kept: 0, gaveUp: 1 })
    expect(await files()).toEqual(['2026-09-10T010000000Z-aaaaaaaa.json.unapplied'])
    expect(said.join(' ')).toContain('giving up')
    expect(said.join(' ')).toContain('dsp_boom')
  })

  it('stops trying when it cannot even record the attempt', async () => {
    await queue({ at: '2026-09-10T01:00:00.000Z', nonce: 'aaaaaaaa', dispatchId: 'dsp_boom' })
    // A directory where the rewrite has to land: the attempt cannot be counted, so it cannot be
    // bounded either, and going round again forever is the one outcome that is not allowed.
    await fs.mkdir(
      path.join(
        dir,
        pendingReportTempName(
          pendingReportFileName({ queuedAt: '2026-09-10T01:00:00.000Z', nonce: 'aaaaaaaa' })
        )
      ),
      { recursive: true }
    )
    const said: string[] = []
    const r = await applyPendingReports({
      queued: await readPendingReports({ dir, log: () => {} }),
      apply: async () => {
        throw new Error('disk on fire')
      },
      log: (m) => said.push(m)
    })
    expect(r.gaveUp).toBe(1)
    expect(await files()).toContain('2026-09-10T010000000Z-aaaaaaaa.json.unapplied')
    expect(said.join(' ')).toContain('giving up')
  })

  it('does nothing at all, and says nothing, when the queue is empty', async () => {
    const said: string[] = []
    const r = await applyPendingReports({ queued: [], apply: async () => ({ ok: true, detail: '' }), log: (m) => said.push(m) })
    expect(r).toEqual({ applied: 0, rejected: 0, kept: 0, gaveUp: 0 })
    expect(said).toEqual([])
  })
})

// Why the queue is read before the restart cleanup and drained before the recovery sweep. Both ends
// are exercised here because neither half is worth anything alone: the cleanup decides whether the
// Dispatch is still open, and only an open Dispatch can take the report.
describe('a report that arrived while the app was away, from the boot the app then has', () => {
  const stored = (): OrchState => ({
    ...emptyState(),
    runs: [{ id: 'run_1', objective: 'o', cwd: 'D:/p', createdAt: '2026-09-10T00:00:00.000Z' }],
    tasks: [
      {
        id: 'tsk_1',
        runId: 'run_1',
        title: 't',
        spec: 's',
        deps: [],
        status: 'dispatched',
        consecutiveFailures: 0,
        createdAt: '2026-09-10T00:00:00.000Z',
        updatedAt: '2026-09-10T00:00:00.000Z'
      }
    ],
    dispatches: [
      {
        id: 'dsp_1',
        taskId: 'tsk_1',
        provider: 'claude',
        accountId: 'acc1',
        sessionId: 'sess_1',
        cwd: 'D:/p',
        specPath: 'D:/p/spec.md',
        startedAt: '2026-09-10T00:00:00.000Z',
        workerState: 'ready',
        retained: false
      }
    ]
  })

  const bootWith = async (reported: ReadonlySet<string> | undefined): Promise<OrchState> => {
    const file = path.join(dir, 'orchestration.json')
    await fs.writeFile(file, JSON.stringify(stored()), 'utf8')
    const store = new OrchestrationStore(file)
    // No Host, so nothing survived to be alive — the case that matters most, because it is the one
    // where the worker really did finish and really is gone.
    await store.load({ reportedDispatchIds: reported })
    return store.get()
  }

  const reportOf = (s: OrchState): OrchState => {
    const r = applyWorkerDone(
      s,
      { taskId: 'tsk_1', dispatchId: 'dsp_1', outcome: 'succeeded', subject: 'done', body: 'done' },
      '2026-09-10T04:00:00.000Z'
    )
    return r.ok ? r.state : s
  }

  it('closes the Task, and recovery finds nothing to restart', async () => {
    const after = reportOf(await bootWith(new Set(['dsp_1'])))
    expect(after.tasks[0].status).toBe('completed')
    expect(candidates(after)).toEqual([])
  })

  it('is thrown away, and a second agent is dispatched, if the cleanup writes the Dispatch off first', async () => {
    const after = reportOf(await bootWith(undefined))
    expect(after.tasks[0].status).toBe('dispatched')
    expect(candidates(after).map((c) => c.taskId)).toEqual(['tsk_1'])
  })
})
