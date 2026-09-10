import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  PENDING_REPORTS_DIR,
  isQueueableReport,
  pendingReportsDirFrom,
  pendingReportFileName,
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
  it('takes the completion report', () => {
    expect(isQueueableReport({ cmd: 'send', args: { type: 'worker_done' } })).toBe(true)
  })
  it('takes the escalation', () => {
    expect(isQueueableReport({ cmd: 'send', args: { type: 'escalation' } })).toBe(true)
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
    expect(isQueueableReport({ cmd: 'send', args: { type: 'status' } })).toBe(false)
    expect(isQueueableReport({ cmd: 'send', args: { type: 'heartbeat' } })).toBe(false)
  })
  it('refuses a send with no type — the server would reject it too', () => {
    expect(isQueueableReport({ cmd: 'send', args: {} })).toBe(false)
    expect(isQueueableReport({ cmd: 'send', args: { type: true } })).toBe(false)
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

describe('serializePendingReport / parsePendingReport', () => {
  it('round-trips a report', () => {
    expect(parsePendingReport(serializePendingReport(entry()))).toEqual(entry())
  })
  it('reads back a body with newlines in it', () => {
    const e = entry({ args: { type: 'worker_done', body: 'one\ntwo\nthree' } })
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
    const e = entry({ args: { type: 'escalation', dispatchId: 'dsp_2' } })
    expect(reportedDispatchIdsOf([e])).toEqual(new Set())
  })
  it('leaves out a report that names no Dispatch', () => {
    expect(reportedDispatchIdsOf([entry({ args: { type: 'worker_done' } })])).toEqual(new Set())
  })
  it('collects across several reports', () => {
    const a = entry()
    const b = entry({ args: { type: 'worker_done', dispatchId: 'dsp_9' } })
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
})
