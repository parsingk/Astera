import { describe, it, expect } from 'vitest'
import { cliEnvFor, MANAGED_ENV_KEYS } from './cliEnv'
import { makeDescriptors } from '../providers/descriptor'
import type { Account } from '../types'

const descriptors = makeDescriptors('win32')
const account = (configDir: string): Account =>
  ({ id: 'acc', label: 'x', configDir, color: '#fff', createdAt: '2026-07-20T00:00:00Z', provider: 'codex' }) as Account

describe('cliEnvFor', () => {
  it('sets CODEX_HOME to a managed dir and drops the app-managed keys', () => {
    const env = cliEnvFor({
      base: { PATH: 'p', ASTERA_SESSION: 's', CODEX_HOME: 'old' },
      account: account('C:/accounts/a1'),
      descriptor: descriptors.codex,
      homeDir: 'C:/Users/me'
    })
    expect(env.CODEX_HOME).toBe('C:/accounts/a1')
    expect(env.PATH).toBe('p')
    for (const k of MANAGED_ENV_KEYS) expect(k in env).toBe(false)
  })
  it('leaves the ambient dir to the CLI by deleting the variable', () => {
    const env = cliEnvFor({
      base: { CODEX_HOME: 'stale' },
      account: account('C:/Users/me/.codex'),
      descriptor: descriptors.codex,
      homeDir: 'C:/Users/me'
    })
    expect('CODEX_HOME' in env).toBe(false)
  })
})
