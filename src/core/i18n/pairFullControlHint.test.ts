// A pairing is read-only by default now, so the person refused a change has to be told how to get full control: the
// command to run on the Runtime, in every language and in the CLI's meaning for the refusal.
import { describe, it, expect } from 'vitest'
import { en } from './messages/en'
import { ko } from './messages/ko'
import { ja } from './messages/ja'
import { es } from './messages/es'
import { agentContext } from '../orchestration/cliAgentContext'
import { nextStepsFor } from '../orchestration/cliOutput'

describe('the read-only refusal names the way to full control', () => {
  it('in every language', () => {
    for (const m of [en, ko, ja, es]) expect(m['jobs.runtime.readOnlyReason']).toContain('astera runtime pair --full-control')
  })
  // Final review M2: the app's pairing hint told the person to run the bare command, which now pairs read-only.
  it("in the app's pairing hint, in every language", () => {
    for (const m of [en, ko, ja, es]) expect(m['settings.remote.pair.hint']).toContain('--full-control')
  })
  // Final review I1: a refused CLI or MCP call came back with no next step, and read-only is the default now.
  it('in the next steps of a refused change', () => {
    const steps = nextStepsFor({ code: 'RUNTIME_PERMISSION_DENIED', cmd: 'jobs-run' })
    expect(steps.join('\n')).toContain('astera runtime pair --full-control')
    expect(steps.join('\n')).toContain('astera runtimes add --pair')
  })
  it('in the CLI meaning of RUNTIME_PERMISSION_DENIED', () => {
    const row = agentContext().exitCodes.find((e) => e.code === 'RUNTIME_PERMISSION_DENIED')
    expect(row?.meaning).toContain('astera runtime pair --full-control')
  })
})
