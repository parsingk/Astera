// What the Run detail does with the Host's answer to `runs-report`.
import { describe, it, expect } from 'vitest'
import { RUN_REPORT_VERSION, type RunReport } from '../../../core/runReport/types'
import { runReportViewOf } from './runReportView'

const report = { version: RUN_REPORT_VERSION, runId: 'r1' } as RunReport

describe('runReportViewOf', () => {
  it('a 200 with a report is ok, and the comment is passed through', () => {
    const comment = { url: 'https://x/1', at: '2026-11-15T00:00:00Z' }
    expect(runReportViewOf({ status: 200, body: { runId: 'r1', report, comment } })).toEqual({ kind: 'ok', report, comment })
    expect(runReportViewOf({ status: 200, body: { runId: 'r1', report } })).toEqual({ kind: 'ok', report })
  })
  it('a 200 with no report is none', () => {
    expect(runReportViewOf({ status: 200, body: { runId: 'r1', report: null } })).toEqual({ kind: 'none' })
    expect(runReportViewOf({ status: 200, body: { runId: 'r1' } })).toEqual({ kind: 'none' })
  })
  it('a refusal, an unknown command, a failed read and no answer are none', () => {
    for (const status of [400, 403, 404, 501]) expect(runReportViewOf({ status, body: { report } })).toEqual({ kind: 'none' })
    expect(runReportViewOf(null)).toEqual({ kind: 'none' })
    expect(runReportViewOf({ status: 200, body: null })).toEqual({ kind: 'none' })
  })
  it('a report of another version is none', () => {
    expect(runReportViewOf({ status: 200, body: { runId: 'r1', report: { ...report, version: RUN_REPORT_VERSION + 1 } } })).toEqual({ kind: 'none' })
  })
})
