import { describe, it, expect } from 'vitest'
import type { Diagnostic } from '../../../core/problems/diagnostic'
import { CATALOGS, LANGS } from '../../../core/i18n'
import { REPAIR_REFUSALS, repairAnswer, repairRequestOf } from './problemsRepair'

// Phase 3 Part 1: the chosen Problems rows as a repair request to their Task, and the Host's answer as the app says it
const row = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  schemaVersion: 1,
  id: 'check:t1:lint:0',
  ref: 'check:t1:0123456789ab',
  source: { kind: 'check', id: 'plugin:lint', label: 'Lint' },
  severity: 'error',
  message: 'x is not defined',
  path: 'D:\\repo\\src\\a.ts',
  line: 3,
  origin: { runId: 'r1', taskId: 't1', task: 'Auth', job: 'Login' },
  ...over
})

describe('repairRequestOf', () => {
  it('asks the rows’ one Task with each row’s reference and words', () => {
    const review = row({ id: 'review:t1:i1', ref: 'review:t1:aaaaaaaaaaaa', source: { kind: 'review', id: 'review', label: 'Review' }, message: 'off by one', line: 7 })
    expect(repairRequestOf([row(), review], 'D:\\repo')).toEqual({
      task: 't1',
      finding: ['check:t1:0123456789ab', 'review:t1:aaaaaaaaaaaa'],
      texts: { 'check:t1:0123456789ab': 'error src/a.ts:3 Lint: x is not defined', 'review:t1:aaaaaaaaaaaa': 'error src/a.ts:7 Review: off by one' }
    })
  })

  // Final review M6: one rule hit on two lines is one reference; the worker must hear of both lines, once each
  it('names a reference two rows share once, with both rows’ words', () => {
    const r = repairRequestOf([row(), row({ id: 'check:t1:lint:1', line: 9 })], 'D:\\repo')
    expect(r?.finding).toEqual(['check:t1:0123456789ab'])
    expect(r?.texts['check:t1:0123456789ab']).toBe('error src/a.ts:3 Lint: x is not defined; error src/a.ts:9 Lint: x is not defined')
  })

  it('writes a worker folder’s file relative to that folder', () => {
    const r = repairRequestOf([row({ path: 'F:\\wt\\t1\\src\\a.ts', root: 'F:\\wt\\t1' })], 'D:\\repo')
    expect(r?.texts['check:t1:0123456789ab']).toBe('error src/a.ts:3 Lint: x is not defined')
  })

  it('takes no rows of two Tasks, a row of no Task, or a row without a reference', () => {
    expect(repairRequestOf([row(), row({ origin: { runId: 'r1', taskId: 't2', task: 'Other' } })], 'D:\\repo')).toBeNull()
    expect(repairRequestOf([row({ origin: undefined })], 'D:\\repo')).toBeNull()
    expect(repairRequestOf([row({ ref: undefined })], 'D:\\repo')).toBeNull()
    expect(repairRequestOf([], 'D:\\repo')).toBeNull()
  })
})

describe('repairAnswer', () => {
  it('reads a taken request with how many findings ride', () => {
    expect(repairAnswer({ status: 200, body: { taskId: 't1', via: 'failed', asked: 20 } })).toEqual({ kind: 'ok', asked: 20 })
    expect(repairAnswer({ status: 200, body: { taskId: 't1', via: 'failed' } })).toEqual({ kind: 'ok' })
  })

  // Final review M10, M14: every refusal offers the draft, whenever it comes: a dry run's, the real call's after the
  // state moved, a Task gone since the list (404), or a Runtime that does not let this app ask (403)
  it('reads each refusal as its sentence, an unknown reason as not repairable', () => {
    expect(repairAnswer({ status: 409, body: { error: 'x', reason: 'folder-in-use' } })).toEqual({ kind: 'refused', key: 'problems.fix.refused.folder-in-use' })
    expect(repairAnswer({ status: 409, body: { error: 'x', reason: 'something-newer' } })).toEqual({ kind: 'refused', key: 'problems.fix.refused.not-repairable' })
    expect(repairAnswer({ status: 404, body: { error: 'unknown task: t1' } })).toEqual({ kind: 'refused', key: 'problems.fix.refused.unknown-task' })
    expect(repairAnswer({ status: 403, body: { error: 'no', code: 'RUNTIME_PERMISSION_DENIED' } })).toEqual({ kind: 'refused', key: 'problems.fix.refused.here' })
  })

  it('reads anything else as a failure with its words', () => {
    expect(repairAnswer({ status: 0, body: { error: 'Host is not running' } })).toEqual({ kind: 'failed', error: 'Host is not running' })
    expect(repairAnswer({ status: 500, body: null })).toEqual({ kind: 'failed', error: '500' })
    expect(repairAnswer({ status: 409, body: { error: 'the repair could not be opened: no account' } })).toEqual({ kind: 'failed', error: 'the repair could not be opened: no account' })
  })

  it('has a sentence for every refusal in every language', () => {
    for (const lang of LANGS)
      for (const reason of [...REPAIR_REFUSALS, 'here']) expect((CATALOGS[lang].messages as Record<string, string | undefined>)[`problems.fix.refused.${reason}`], `${lang} ${reason}`).toBeTruthy()
  })
})
