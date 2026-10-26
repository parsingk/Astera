import { describe, it, expect, vi } from 'vitest'

// The project folder is asked about asynchronously, with a time limit (core/sessions/pathProbe.ts). A
// sync existsSync on a folder on a dead network share froze the Electron main thread for 20 to 60 s.
// `spawn` is mocked so a test that got past the check would show it, rather than start a real CLI.
const spawned = vi.hoisted(() => [] as string[])
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn(() => {
      spawned.push('spawn')
      throw new Error('no spawn in this test')
    })
  }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: vi.fn(actual.existsSync) }
})

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { runAgent } from './agent'
import { makeDescriptors } from '../providers/descriptor'
import type { Account } from '../types'

const account = { id: 'a1', provider: 'claude', configDir: 'C:/nowhere/.claude' } as unknown as Account
const base = {
  account,
  descriptors: makeDescriptors(process.platform),
  generator: {},
  cwd: 'Z:/dead-share/project',
  prompt: 'p'
}

describe('runAgent, the project folder check', () => {
  it('a folder that does not answer in time is said as not reachable, and nothing is started', async () => {
    spawned.length = 0
    const asked: string[] = []
    const r = await runAgent({ ...base, probe: async (p) => { asked.push(p); return 'timeout' } })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('닿지 않는다')
    expect(asked).toEqual([base.cwd])
    expect(spawned).toEqual([])
    expect(vi.mocked(existsSync)).not.toHaveBeenCalledWith(base.cwd)
  })

  it('a folder that is not there is said as missing', async () => {
    spawned.length = 0
    const r = await runAgent({ ...base, probe: async () => 'absent' })
    expect((r as { reason: string }).reason).toContain('프로젝트 폴더가 없다')
    expect(spawned).toEqual([])
  })

  it('a folder that is there goes on to start the agent', async () => {
    spawned.length = 0
    const r = await runAgent({ ...base, probe: async () => 'present' })
    expect(spawned).toEqual(['spawn'])
    expect((r as { reason: string }).reason).toContain('실행하지 못했다')
  })
})

// Credentials final review M12: it is an agent Astera starts in the project, so the Credentials list keeps the same keys
// out of it as out of a session started there
describe('runAgent, the Credentials list', () => {
  it('starts the agent without what the list hides for the project folder', async () => {
    vi.stubEnv('GH_TOKEN', 'inherited-token')
    vi.mocked(spawn).mockClear()
    const asked: string[] = []
    await runAgent({
      ...base,
      probe: async () => 'present',
      hiding: { get: (cwd) => (asked.push(cwd), { remove: ['GH_TOKEN'], set: {} }), damaged: () => false }
    })
    vi.unstubAllEnvs()
    expect(asked).toEqual([base.cwd])
    const env = vi.mocked(spawn).mock.calls[0][2]?.env as Record<string, string | undefined>
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toBe(account.configDir)
  })
})
