// What the sandbox blocks (sandbox design §6, "Coverage with the sandbox"), per CLI and OS, as measured: Windows on this
// PC (inventory §23.3), macOS and Linux on GitHub's runners (§23.4, §22). Nothing here claims what was not measured.
import { describe, it, expect } from 'vitest'
import { SANDBOX_COVERAGE } from './coverage'
import type { SandboxCoverageRow } from '../audit/types'

const cell = (provider: SandboxCoverageRow['provider'], os: SandboxCoverageRow['os'], c: keyof SandboxCoverageRow['classes']) =>
  SANDBOX_COVERAGE.find((r) => r.provider === provider && r.os === os)?.classes[c]

describe('SANDBOX_COVERAGE', () => {
  it('has one row per CLI and OS', () => {
    expect(SANDBOX_COVERAGE.map((r) => `${r.provider} ${r.os}`)).toEqual([
      'claude win32',
      'claude darwin',
      'claude linux',
      'codex win32',
      'codex darwin',
      'codex linux'
    ])
  })

  it('the sandbox coverage claims only what was measured', () => {
    // Codex: writes, the folders holding logins and the OS stores, on all three (macOS and Linux with the denies Astera adds)
    for (const os of ['win32', 'darwin', 'linux'] as const) {
      expect(cell('codex', os, 'write'), os).toEqual({ level: 'enforced' })
      expect(cell('codex', os, 'sensitive'), os).toEqual({ level: 'enforced' })
      expect(cell('codex', os, 'stores'), os).toEqual({ level: 'enforced' })
    }
    expect(cell('codex', 'linux', 'stores')).toEqual({ level: 'enforced' })
    // Claude on macOS and Linux: the runtime (srt) was measured, not Claude Code's own use of it, and the stores say so
    for (const os of ['darwin', 'linux'] as const) {
      expect(cell('claude', os, 'write'), os).toEqual({ level: 'enforced' })
      expect(cell('claude', os, 'sensitive'), os).toEqual({ level: 'enforced' })
      expect(cell('claude', os, 'stores'), os).toEqual({ level: 'enforced', note: 'runtime-measured' })
    }
    // Claude on Windows has no sandbox: only its file tools are kept out of the folders holding logins
    expect(cell('claude', 'win32', 'write')).toEqual({ level: 'none' })
    expect(cell('claude', 'win32', 'sensitive')).toEqual({ level: 'partial', note: 'file-tools-only' })
    expect(cell('claude', 'win32', 'stores')).toEqual({ level: 'none' })
  })

  // E3: the network is allowed inside the sandbox, everywhere
  it('allows the network everywhere', () => {
    for (const r of SANDBOX_COVERAGE) expect(r.classes.network, `${r.provider} ${r.os}`).toEqual({ level: 'seen' })
  })
})
