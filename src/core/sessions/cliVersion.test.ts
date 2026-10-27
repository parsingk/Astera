import { describe, expect, it, vi } from 'vitest'
import { ENFORCE_MIN, atLeast, enforceBlocker, makeCliVersionProbe, parseCliVersion } from './cliVersion'

// Enforce (enforce design E5): a CLI too old to honour the blocking hook does not start in Enforce
describe('the CLI version Enforce needs', () => {
  it('reads both CLIs’ real --version output', () => {
    expect(parseCliVersion('2.1.311 (Claude Code)\n')).toBe('2.1.311')
    expect(parseCliVersion('codex-cli 0.160.0\r\n')).toBe('0.160.0')
    expect(parseCliVersion('codex-cli 0.161.0-alpha.2')).toBe('0.161.0')
    expect(parseCliVersion('')).toBeNull()
    expect(parseCliVersion('command not found')).toBeNull()
  })

  it('compares versions by number, not by text', () => {
    expect(atLeast('2.1.306', '2.1.306')).toBe(true)
    expect(atLeast('2.1.40', '2.1.306')).toBe(false)
    expect(atLeast('10.0.0', '2.1.306')).toBe(true)
    expect(atLeast('2.2.0', '2.1.306')).toBe(true)
    expect(atLeast('0.159.9', '0.160.0')).toBe(false)
  })

  it('says why a CLI cannot be enforced, and nothing when it can', () => {
    expect(ENFORCE_MIN).toEqual({ claude: '2.1.306', codex: '0.160.0' })
    expect(enforceBlocker('claude', '2.1.311')).toBeNull()
    expect(enforceBlocker('codex', '0.160.0')).toBeNull()
    expect(enforceBlocker('claude', '2.1.300')).toBe('ENFORCE_UNAVAILABLE: cli-too-old claude 2.1.300 2.1.306')
    expect(enforceBlocker('codex', '0.159.0')).toBe('ENFORCE_UNAVAILABLE: cli-too-old codex 0.159.0 0.160.0')
    expect(enforceBlocker('codex', null)).toBe('ENFORCE_UNAVAILABLE: cli-version-unknown codex')
    // Final review M2: a CLI that is not there is said so
    expect(enforceBlocker('claude', undefined)).toBe('ENFORCE_UNAVAILABLE: cli-missing claude')
  })
})

describe('makeCliVersionProbe', () => {
  it('asks each CLI once, and again after an update or the TTL', () => {
    let now = 0
    let identity = 'C:/bin/codex.exe|1|10'
    const run = vi.fn((cmd: { file: string; args: string[] }) => (cmd.args.includes('--version') ? (cmd.file.includes('claude') ? '2.1.311 (Claude Code)' : 'codex-cli 0.160.0') : null))
    const probe = makeCliVersionProbe({
      platform: 'win32',
      resolve: (name) => `C:/bin/${name}.exe`,
      run,
      identity: (f) => (f.includes('codex') ? identity : f),
      now: () => now
    })
    expect(probe('codex')).toBe('0.160.0')
    expect(probe('claude')).toBe('2.1.311')
    expect(probe('codex')).toBe('0.160.0')
    expect(run).toHaveBeenCalledTimes(2)
    identity = 'C:/bin/codex.exe|2|11'
    probe('codex')
    expect(run).toHaveBeenCalledTimes(3)
    now = 11 * 60 * 1000
    probe('codex')
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('a warmed answer is read without running anything on the calling thread', async () => {
    const run = vi.fn(() => 'never')
    const probe = makeCliVersionProbe({
      platform: 'linux',
      run,
      runAsync: async () => 'codex-cli 0.160.0',
      which: () => '/usr/bin/codex',
      whichAsync: async () => '/usr/bin/codex',
      identity: () => 'codex-1',
      identityAsync: async () => 'codex-1',
      now: () => 0
    })
    await probe.warm('codex')
    expect(probe('codex')).toBe('0.160.0')
    expect(run).not.toHaveBeenCalled()
  })

  it('a CLI that is not there is missing, not of an unknown version', () => {
    const probe = makeCliVersionProbe({ platform: 'win32', resolve: () => null, run: () => 'x', now: () => 0 })
    expect(probe('claude')).toBeUndefined()
    const posix = makeCliVersionProbe({ platform: 'linux', which: () => null, run: () => 'x', now: () => 0 })
    expect(posix('codex')).toBeUndefined()
  })

  // Final review M1: an answer that failed is asked again, and an update on macOS and Linux is seen at once
  it('does not keep a failed answer, and asks again after an update on every platform', () => {
    let answer: string | null = null
    let identity = '/usr/local/bin/codex|1|10'
    const run = vi.fn(() => answer)
    const probe = makeCliVersionProbe({ platform: 'darwin', which: () => '/usr/local/bin/codex', identity: () => identity, run, now: () => 0 })
    expect(probe('codex')).toBeNull()
    answer = 'codex-cli 0.159.0'
    expect(probe('codex')).toBe('0.159.0')
    expect(run).toHaveBeenCalledTimes(2)
    answer = 'codex-cli 0.160.0'
    expect(probe('codex')).toBe('0.159.0')
    identity = '/usr/local/bin/codex|2|11'
    expect(probe('codex')).toBe('0.160.0')
  })
})
