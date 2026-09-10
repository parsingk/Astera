import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  queueableReportProblem,
  PENDING_REPORTS_DIR,
  isQueueableReport,
  pendingReportsDirFrom,
  pendingReportFileName,
  pendingReportTempName,
  serializePendingReport,
  parsePendingReport,
  reportedDispatchIdsOf,
  undeliveredReportNotice,
  type PendingReport
} from './pendingReports'

const entry = (over: Partial<PendingReport> = {}): PendingReport => ({
  queuedAt: '2026-09-10T01:02:03.004Z',
  sessionId: 'sess_1',
  cmd: 'send',
  args: { type: 'worker_done', taskId: 'tsk_1', dispatchId: 'dsp_1', outcome: 'succeeded' },
  ...over
})

describe('isQueueableReport — which commands a file can stand in for', () => {
  // The two refusals reach the worker differently on purpose: an agent one flag short of a report
  // the app would have taken can fix that itself, and only if it is told which flag.
  it('names the missing flag rather than the absent app', () => {
    expect(queueableReportProblem({ cmd: 'inbox', args: {} })).toBe('not a report')
    expect(
      queueableReportProblem({ cmd: 'send', args: { type: 'worker_done', dispatchId: 'd1' } })
    ).toContain('--task-id')
    expect(
      queueableReportProblem({ cmd: 'send', args: { type: 'worker_done', taskId: 't1' } })
    ).toContain('--dispatch-id')
    expect(
      queueableReportProblem({
        cmd: 'send',
        args: { type: 'worker_done', taskId: 't1', dispatchId: 'd1' }
      })
    ).toContain('outcome')
    expect(
      queueableReportProblem({
        cmd: 'send',
        args: { type: 'worker_done', taskId: 't1', dispatchId: 'd1', outcome: 'succeeded' }
      })
    ).toBeNull()
  })

  const done = { type: 'worker_done', taskId: 'tsk_1', dispatchId: 'dsp_1', outcome: 'succeeded' }
  const escalation = { type: 'escalation', taskId: 'tsk_1', dispatchId: 'dsp_1' }

  it('takes the completion report', () => {
    expect(isQueueableReport({ cmd: 'send', args: done })).toBe(true)
    expect(isQueueableReport({ cmd: 'send', args: { ...done, outcome: 'failed' } })).toBe(true)
  })
  it('takes the escalation', () => {
    expect(isQueueableReport({ cmd: 'send', args: escalation })).toBe(true)
  })
  // A report the server would reject must fail now, the way it does today, so the agent can correct
  // itself. Queued, it would be answered "recorded, do not send it again", hold its Dispatch open
  // through the restart cleanup, and then be refused by the drain -- a Task stalled for the rest of
  // the app session by a typo.
  it('refuses a completion report the server would reject as incomplete', () => {
    expect(isQueueableReport({ cmd: 'send', args: { ...done, outcome: undefined } })).toBe(false)
    expect(isQueueableReport({ cmd: 'send', args: { ...done, outcome: 'done' } })).toBe(false)
    expect(isQueueableReport({ cmd: 'send', args: { ...done, taskId: undefined } })).toBe(false)
    expect(isQueueableReport({ cmd: 'send', args: { ...done, dispatchId: '' } })).toBe(false)
  })
  // Stricter than the live path, which fills a missing dispatchId in from the session's open
  // Dispatch. By the time the queue is drained there may be no open Dispatch to read it from.
  it('refuses an escalation that does not name its Task and Dispatch', () => {
    expect(isQueueableReport({ cmd: 'send', args: { ...escalation, dispatchId: undefined } })).toBe(false)
    expect(isQueueableReport({ cmd: 'send', args: { ...escalation, taskId: undefined } })).toBe(false)
  })
  it('refuses ask — a file cannot answer a question', () => {
    expect(isQueueableReport({ cmd: 'ask', args: { question: 'which one?' } })).toBe(false)
  })
  it('refuses the commands that read state', () => {
    expect(isQueueableReport({ cmd: 'check', args: { wait: true } })).toBe(false)
    expect(isQueueableReport({ cmd: 'inbox', args: {} })).toBe(false)
    expect(isQueueableReport({ cmd: 'worker-read', args: { dispatch: 'dsp_1' } })).toBe(false)
  })
  it('refuses the message types a worker is never told to send', () => {
    expect(isQueueableReport({ cmd: 'send', args: { ...done, type: 'status' } })).toBe(false)
    expect(isQueueableReport({ cmd: 'send', args: { ...done, type: 'heartbeat' } })).toBe(false)
  })
  it('refuses a send with no type — the server would reject it too', () => {
    expect(isQueueableReport({ cmd: 'send', args: {} })).toBe(false)
    expect(isQueueableReport({ cmd: 'send', args: { ...done, type: true } })).toBe(false)
  })
  it('refuses the commands that change a Run', () => {
    expect(isQueueableReport({ cmd: 'run-create', args: { objective: 'x' } })).toBe(false)
    expect(isQueueableReport({ cmd: 'worker-start', args: { task: 'tsk_1' } })).toBe(false)
    expect(isQueueableReport({ cmd: 'task-update', args: { id: 'tsk_1' } })).toBe(false)
  })
})

describe('pendingReportsDirFrom', () => {
  it('is a folder beside the info file the CLI already reads', () => {
    const info = path.join('C:', 'u', 'orch', 'orch-info.json')
    expect(pendingReportsDirFrom(info)).toBe(path.join('C:', 'u', 'orch', PENDING_REPORTS_DIR))
  })
})

describe('pendingReportFileName', () => {
  it('sorts by the moment it was queued', () => {
    const a = pendingReportFileName({ queuedAt: '2026-09-10T01:02:03.004Z', nonce: 'ffffffff' })
    const b = pendingReportFileName({ queuedAt: '2026-09-10T01:02:03.005Z', nonce: '00000000' })
    expect([b, a].sort()).toEqual([a, b])
  })
  it('carries the nonce, so two reports queued in the same millisecond are two files', () => {
    const a = pendingReportFileName({ queuedAt: '2026-09-10T01:02:03.004Z', nonce: 'aaaaaaaa' })
    const b = pendingReportFileName({ queuedAt: '2026-09-10T01:02:03.004Z', nonce: 'bbbbbbbb' })
    expect(a).not.toBe(b)
  })
  it('holds no character win32 refuses in a file name', () => {
    const name = pendingReportFileName({ queuedAt: '2026-09-10T01:02:03.004Z', nonce: 'aaaaaaaa' })
    expect(name).toMatch(/^[A-Za-z0-9_.-]+\.json$/)
  })
})

describe('pendingReportTempName', () => {
  it('is not a name the reader picks up — that is the whole of its job', () => {
    const name = pendingReportTempName(
      pendingReportFileName({ queuedAt: '2026-09-10T01:02:03.004Z', nonce: 'aaaaaaaa' })
    )
    expect(name.endsWith('.json')).toBe(false)
  })
})

describe('serializePendingReport / parsePendingReport', () => {
  it('round-trips a report', () => {
    expect(parsePendingReport(serializePendingReport(entry()))).toEqual(entry())
  })
  it('reads back a body with newlines in it', () => {
    const e = entry({ args: { ...entry().args, body: 'one\ntwo\nthree' } })
    expect(parsePendingReport(serializePendingReport(e))).toEqual(e)
  })
  it('is null for a file that is not JSON', () => {
    expect(parsePendingReport('{half writ')).toBeNull()
  })
  it('is null for JSON that is not a report', () => {
    expect(parsePendingReport('[]')).toBeNull()
    expect(parsePendingReport('{"cmd":"send"}')).toBeNull()
    expect(parsePendingReport(JSON.stringify({ ...entry(), args: 'nope' }))).toBeNull()
  })
  it('is null for a command that would not have been queued in the first place', () => {
    expect(parsePendingReport(JSON.stringify(entry({ cmd: 'ask' })))).toBeNull()
  })
})

describe('reportedDispatchIdsOf — which Dispatches a queued report speaks for', () => {
  it('names the Dispatch of a completion report', () => {
    expect(reportedDispatchIdsOf([entry()])).toEqual(new Set(['dsp_1']))
  })
  it('leaves out an escalation — the worker said it was stuck, not that it was done', () => {
    const e = entry({ args: { type: 'escalation', taskId: 'tsk_1', dispatchId: 'dsp_2' } })
    expect(reportedDispatchIdsOf([e])).toEqual(new Set())
  })
  it('leaves out a report that names no Dispatch', () => {
    expect(reportedDispatchIdsOf([entry({ args: { type: 'worker_done' } })])).toEqual(new Set())
  })
  it('collects across several reports', () => {
    const a = entry()
    const b = entry({ args: { ...entry().args, dispatchId: 'dsp_9' } })
    expect(reportedDispatchIdsOf([a, b])).toEqual(new Set(['dsp_1', 'dsp_9']))
  })
})

describe('undeliveredReportNotice — what the agent is told', () => {
  const notice = JSON.parse(undeliveredReportNotice({ path: 'C:\\u\\orch\\pending-reports\\a.json' }))
  it('says it was recorded', () => {
    expect(notice.queued).toBe(true)
    expect(notice.path).toBe('C:\\u\\orch\\pending-reports\\a.json')
  })
  it('says it was not applied — the other half an agent has to read', () => {
    expect(notice.applied).toBe(false)
  })
  it('is not an ok: nothing in it claims the report went through', () => {
    expect(notice.ok).toBeUndefined()
    expect(notice.sent).toBeUndefined()
    expect(notice.error).toBeUndefined()
  })
  it('tells the agent not to send it again', () => {
    expect(String(notice.note)).toMatch(/again/)
  })
  // The same notice answers an escalation, where the worker is stuck and its work is not over.
  it('does not tell the worker its work here is finished', () => {
    expect(String(notice.note)).not.toMatch(/finish/i)
  })
  // It used to give "a second copy would not reach the app either" as the reason. Once the app is
  // back a second copy reaches it perfectly well -- an agent that tries and finds it works learns
  // that the notice can be wrong about the rest too.
  it('gives a reason not to send it again that stays true after the app is back', () => {
    expect(String(notice.note)).not.toMatch(/would not reach/)
    expect(String(notice.note)).toMatch(/already has/)
  })
  // Whether the app applies it depends on the orchestration toggle, which the worker cannot see.
  it('does not promise the next start will apply it', () => {
    expect(String(notice.note)).not.toMatch(/next time it starts/)
  })
})
