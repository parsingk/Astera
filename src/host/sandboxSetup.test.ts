// 설정하기 on the Host: the setup runs for the one account, in its own Codex home. The run is a fake: the real one brings
// up Windows' administrator prompt.
import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Account } from '../core/types'
import { removeFixture } from '../core/testFixtures'
import { makeDescriptors } from '../core/providers/descriptor'
import { DOCTOR_ARGV, SETUP_ARGV } from '../core/sandbox/windowsReadiness'
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

  // Task P: Codex's setup writes `windows.sandbox = "elevated"` into the home's config.toml, which would put every other
  // Codex session of the home in the elevated sandbox too; Astera's sandboxed sessions name it themselves, so the line
  // the setup added is taken back out of the home that was set up, the ambient account's ~/.codex included
  it("takes the default Codex's setup wrote back out of the account's own config.toml, and says so", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-setup-default-'))
    try {
      const work = path.join(home, '.codex-accounts', 'work')
      const ambient = path.join(home, '.codex')
      for (const dir of [work, ambient]) {
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, 'config.toml'), 'model = "gpt-5"\n')
      }
      const logs: string[] = []
      const setUp = hostSandboxSetup({
        platform: 'win32',
        homeDir: home,
        baseEnv: () => ({ Path: 'C:\\Windows' }),
        descriptors: makeDescriptors('win32', home),
        log: (m) => logs.push(m),
        // As Codex does on success: the setup's home is CODEX_HOME, or ~/.codex without one
        run: () => async (_argv, extra) => {
          const file = path.join(extra.CODEX_HOME ?? ambient, 'config.toml')
          await fs.writeFile(file, `${await fs.readFile(file, 'utf8')}\n[windows]\nsandbox = "elevated"\n`)
          return { code: 0, out: 'done' }
        }
      })
      for (const dir of [work, ambient]) {
        expect(await setUp!(account(dir))).toEqual({ ok: true, out: 'done' })
        expect(await fs.readFile(path.join(dir, 'config.toml'), 'utf8'), dir).toBe('model = "gpt-5"\n')
      }
      expect(logs).toEqual([expect.stringContaining(path.join(work, 'config.toml')), expect.stringContaining(path.join(ambient, 'config.toml'))])
    } finally {
      await removeFixture(home)
    }
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

  // Final fix pass (minor 7): opening a sandboxed profile's row in Settings asks Codex's doctor only, never the sandboxed
  // echo, whose effect on a stale home is not measured (it might bring up the administrator prompt); a start still asks both
  it('asks Codex’s doctor only, never the echo', async () => {
    const home = path.join(os.tmpdir(), 'astera-readiness-doctor')
    const argvs: string[][] = []
    const report = (provisioning: string): string => JSON.stringify({ checks: { 'sandbox.helpers': { details: { 'sandbox provisioning': provisioning } } } })
    for (const [provisioning, want] of [['complete', 'ready'], ['incomplete', 'not-set-up']] as const) {
      const readiness = hostSandboxReadiness({
        platform: 'win32',
        homeDir: home,
        baseEnv: () => ({ Path: 'C:\\Windows' }),
        descriptors: makeDescriptors('win32', home),
        run: () => async (argv) => (argvs.push(argv), { code: 0, out: report(provisioning) })
      })
      expect(await readiness!(account(path.join(home, '.codex-accounts', provisioning)))).toBe(want)
    }
    expect(argvs).toEqual([DOCTOR_ARGV, DOCTOR_ARGV])
    expect(argvs.some((a) => a.includes('echo'))).toBe(false)
  })

  it('there is nothing to ask about off Windows', () => {
    for (const platform of ['darwin', 'linux'] as const)
      expect(hostSandboxReadiness({ platform, homeDir: '/h', baseEnv: () => ({}), descriptors: makeDescriptors(platform, '/h') })).toBeUndefined()
  })
})
