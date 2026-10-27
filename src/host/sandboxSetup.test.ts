// 설정하기 on the Host: the setup runs for the one account, in its own Codex home. The run is a fake: the real one brings
// up Windows' administrator prompt.
import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { Account } from '../core/types'
import { makeDescriptors } from '../core/providers/descriptor'
import { SETUP_ARGV } from '../core/sandbox/windowsReadiness'
import { hostSandboxReadiness, hostSandboxSetup } from './sandboxSetup'

const account = (configDir: string): Account => ({ id: 'acc_x', label: 'x', configDir, color: '#888', createdAt: '2026-10-27T00:00:00.000Z', provider: 'codex' })

describe('hostSandboxSetup', () => {
  it("sets up the account's own Codex home, in the Host's environment", async () => {
    // This machine's path form, so the ambient home compares equal on every OS the suite runs on
    const home = path.join(os.tmpdir(), 'astera-setup-home')
    const work = path.join(home, '.codex-accounts', 'work')
    const calls: Array<{ base: Record<string, string | undefined>; argv: string[]; extra: Record<string, string | undefined> }> = []
    const setUp = hostSandboxSetup({
      platform: 'win32',
      homeDir: home,
      baseEnv: () => ({ Path: 'C:\\Windows', CODEX_HOME: 'C:\\inherited' }),
      descriptors: makeDescriptors('win32', home),
      run: (base) => async (argv, extra) => (calls.push({ base, argv, extra }), { code: 0, out: 'done' })
    })
    expect(await setUp!(account(work))).toEqual({ ok: true, out: 'done' })
    expect(calls).toHaveLength(1)
    expect(calls[0].argv).toEqual(SETUP_ARGV)
    expect(calls[0].extra).toEqual({ CODEX_HOME: work })
    expect(calls[0].base.Path).toBe('C:\\Windows')
    // The ambient account's home is the one codex finds without CODEX_HOME, and an inherited one is not passed on
    await setUp!(account(path.join(home, '.codex')))
    expect(calls[1].extra).toEqual({})
    expect(calls[1].base.CODEX_HOME).toBeUndefined()
  })

  it('there is nothing to set up off Windows', () => {
    for (const platform of ['darwin', 'linux'] as const)
      expect(hostSandboxSetup({ platform, homeDir: '/h', baseEnv: () => ({}), descriptors: makeDescriptors(platform, '/h') })).toBeUndefined()
  })
})

// Task 8: Settings › Agent profiles asks each Codex account's readiness through the Host, with the question a sandboxed
// start asks (doctor first, the echo only on a home doctor calls complete), in the account's own home
describe('hostSandboxReadiness', () => {
  it("asks about the account's own Codex home, in the Host's environment, and logs why it could not", async () => {
    const home = path.join(os.tmpdir(), 'astera-readiness-home')
    const work = path.join(home, '.codex-accounts', 'work')
    const asked: Array<{ codexHome: string | null; env: Record<string, string | undefined> }> = []
    const logs: string[] = []
    const readiness = hostSandboxReadiness({
      platform: 'win32',
      homeDir: home,
      baseEnv: () => ({ Path: 'C:\\Windows', CODEX_HOME: 'C:\\inherited' }),
      descriptors: makeDescriptors('win32', home),
      log: (m) => logs.push(m),
      ready: async (a) => (asked.push({ codexHome: a.codexHome, env: a.env }), a.log?.('codex doctor did not answer'), 'not-set-up')
    })
    expect(await readiness!(account(work))).toBe('not-set-up')
    expect(asked[0].codexHome).toBe(work)
    expect(asked[0].env.CODEX_HOME).toBe(work)
    expect(asked[0].env.Path).toBe('C:\\Windows')
    expect(logs).toEqual(['codex doctor did not answer'])
    // The ambient account asks without CODEX_HOME
    await readiness!(account(path.join(home, '.codex')))
    expect(asked[1].codexHome).toBeNull()
  })

  it('there is nothing to ask about off Windows', () => {
    for (const platform of ['darwin', 'linux'] as const)
      expect(hostSandboxReadiness({ platform, homeDir: '/h', baseEnv: () => ({}), descriptors: makeDescriptors(platform, '/h') })).toBeUndefined()
  })
})
