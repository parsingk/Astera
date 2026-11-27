import { describe, it, expect } from 'vitest'
import { EXTERNAL_AGENT_CAPABILITIES, PROVIDER_CAPABILITIES, capabilityGaps } from './capabilities'

// Phase 5 A1 (spec): what each kind of worker can do, said plainly, never emulated
describe('provider capabilities', () => {
  it('declares what Astera does with claude and codex', () => {
    expect(PROVIDER_CAPABILITIES.claude).toEqual({ resume: true, toolApproval: 'interactive', structuredStream: true, limits: true, usageMeter: true, accountRolling: true, cancel: true, models: true, sandbox: true })
    expect(PROVIDER_CAPABILITIES.codex).toEqual({ ...PROVIDER_CAPABILITIES.claude, usageMeter: false })
  })

  it('declares an external agent by what this integration does, whatever the agent offers', () => {
    expect(EXTERNAL_AGENT_CAPABILITIES).toEqual({ resume: false, toolApproval: 'astera', structuredStream: true, limits: false, usageMeter: false, accountRolling: false, cancel: true, models: false, sandbox: false })
  })

  it('names what a worker cannot do, for the places that must say so', () => {
    expect(capabilityGaps(EXTERNAL_AGENT_CAPABILITIES)).toEqual(['resume', 'limits', 'usageMeter', 'accountRolling', 'models', 'sandbox'])
    expect(capabilityGaps(PROVIDER_CAPABILITIES.claude)).toEqual([])
  })
})
