// A pairing is read-only by default now, so the person refused a change has to be told how to get full control: the
// command to run on the Runtime, in every language and in the CLI's meaning for the refusal.
import { describe, it, expect } from 'vitest'
import { en } from './messages/en'
import { ko } from './messages/ko'
import { ja } from './messages/ja'
import { es } from './messages/es'
import { agentContext } from '../orchestration/cliAgentContext'

describe('the read-only refusal names the way to full control', () => {
  it('in every language', () => {
    for (const m of [en, ko, ja, es]) expect(m['jobs.runtime.readOnlyReason']).toContain('astera runtime pair --full-control')
  })
  it('in the CLI meaning of RUNTIME_PERMISSION_DENIED', () => {
    const row = agentContext().exitCodes.find((e) => e.code === 'RUNTIME_PERMISSION_DENIED')
    expect(row?.meaning).toContain('astera runtime pair --full-control')
  })
})
