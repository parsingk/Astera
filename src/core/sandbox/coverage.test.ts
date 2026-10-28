// What the sandbox blocks (sandbox design §6, "Coverage with the sandbox"), per CLI and OS, as measured: Windows on this
// PC (inventory §23.3), macOS and Linux on GitHub's runners (§23.4, §22). Nothing here claims what was not measured.
import { describe, it, expect } from 'vitest'
import { SANDBOX_COVERAGE, SANDBOX_TABLE_CAPTION, sandboxRowCaption } from './coverage'
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
    }
    expect(cell('codex', 'win32', 'stores')).toEqual({ level: 'enforced' })
    expect(cell('codex', 'darwin', 'stores')).toEqual({ level: 'enforced' })
    // Task 8 fix round 1: on Linux the deny names the session bus's file path; an abstract-socket bus is not a path, and
    // is not denied (locations.ts busSocketOf)
    expect(cell('codex', 'linux', 'stores')).toEqual({ level: 'enforced', note: 'bus-path-only' })
    // Claude on macOS and Linux: the runtime (srt) was measured, not Claude Code's own use of it, and every cell the sandbox
    // enforces says so (final fix pass, minor 5: writes and the login folders as well as the stores)
    for (const os of ['darwin', 'linux'] as const) {
      expect(cell('claude', os, 'write'), os).toEqual({ level: 'enforced', note: 'runtime-measured' })
      expect(cell('claude', os, 'sensitive'), os).toEqual({ level: 'enforced', note: 'runtime-measured' })
      expect(cell('claude', os, 'stores'), os).toEqual({ level: 'enforced', note: 'runtime-measured' })
    }
    // Claude on Windows has no sandbox: only its file tools are kept out of the folders holding logins
    expect(cell('claude', 'win32', 'write')).toEqual({ level: 'none' })
    expect(cell('claude', 'win32', 'sensitive')).toEqual({ level: 'partial', note: 'file-tools-only' })
    expect(cell('claude', 'win32', 'stores')).toEqual({ level: 'none' })
  })

  // Task 8 fix round 1: said with the table, under it and beside the Claude Windows row
  it('says that the home stays readable outside the login folders, and that Claude Code’s shell on Windows is not restricted', () => {
    expect(SANDBOX_TABLE_CAPTION).toBe('settings.security.sandboxCoverage.homeReadable')
    expect(SANDBOX_COVERAGE.map((r) => sandboxRowCaption(r))).toEqual(['settings.security.sandboxCoverage.windowsClaude', null, null, null, null, null])
  })

  // E3: the network is allowed inside the sandbox, everywhere
  it('allows the network everywhere', () => {
    for (const r of SANDBOX_COVERAGE) expect(r.classes.network, `${r.provider} ${r.os}`).toEqual({ level: 'seen' })
  })
})
