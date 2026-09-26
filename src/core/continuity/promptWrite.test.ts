import { describe, it, expect } from 'vitest'
import { promptWriteEventOf } from './promptWrite'
import { stateFromLegacy } from '../orchestration/legacyState'

const NOW = '2026-09-26T10:00:00.000Z'
const state = stateFromLegacy({
  runs: [{ id: 'run_1', objective: 'o', cwd: 'D:/p', createdAt: NOW }],
  tasks: [{ id: 'tsk_1', runId: 'run_1', title: 't', spec: 's', deps: [], status: 'dispatched', consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW }],
  dispatches: []
})
const e = { dispatchId: 'dsp_1', taskId: 'tsk_1', phase: 'confirmed' as const, via: 'argv' as const, promptLength: 42, specPath: 'D:/p/s.md' }

describe('promptWriteEventOf (the app wiring, moved to core so the Host builds the same row)', () => {
  it('builds the row the app wrote, keyed once per dispatch and phase, with the actor given', () => {
    expect(promptWriteEventOf(state, e, NOW, { surface: 'host' })).toEqual({
      runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', type: 'PROMPT_WRITE_CONFIRMED', at: NOW,
      idempotencyKey: 'PROMPT_WRITE_CONFIRMED:dsp_1', payload: { via: 'argv', promptLength: 42, specPath: 'D:/p/s.md' },
      actor: { surface: 'host' }
    })
    expect(promptWriteEventOf(state, { ...e, phase: 'requested' }, NOW)?.type).toBe('PROMPT_WRITE_REQUESTED')
  })
  it('is null for a Task the state does not have', () => {
    expect(promptWriteEventOf(state, { ...e, taskId: 'tsk_gone' }, NOW)).toBeNull()
  })
})
