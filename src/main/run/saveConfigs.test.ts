import { describe, it, expect, vi } from 'vitest'
import type { RunConfig } from '../../core/run/types'
import { saveConfigsBatch } from './saveConfigs'

const dev: RunConfig = { id: 'user:1', name: 'dev', type: 'npm', script: 'dev' }
const build: RunConfig = { id: 'user:2', name: 'build', type: 'npm', script: 'build' }
const cwdOk = async (): Promise<void> => {}
// Typed through inference rather than annotated: an annotation of ReturnType<typeof vi.fn> widens to
// the un-instantiated Mock and stops being assignable to saveConfigsBatch's concrete store parameter.
const store = () => ({ save: vi.fn(async (_projectPath: string, _configs: RunConfig[]) => {}) })

describe('saveConfigsBatch', () => {
  it('replaces the stored list wholesale and returns it', async () => {
    const s = store()
    const out = await saveConfigsBatch({ projectPath: '/p', configs: [build, dev], platform: 'linux', assertConfigCwd: cwdOk, store: s })
    expect(out).toEqual({ ok: true, configs: [build, dev] })
    expect(s.save).toHaveBeenCalledWith('/p', [build, dev])
  })

  // A list without a known id is how a deletion arrives — there is no separate delete call
  it('a list missing an id is stored as given', async () => {
    const s = store()
    await saveConfigsBatch({ projectPath: '/p', configs: [dev], platform: 'linux', assertConfigCwd: cwdOk, store: s })
    expect(s.save).toHaveBeenCalledWith('/p', [dev])
  })

  it('one bad item leaves the store untouched and every error is reported', async () => {
    const s = store()
    const bad = { id: 'user:3', name: 'x', type: 'nope' } as unknown as RunConfig
    const out = await saveConfigsBatch({
      projectPath: '/p',
      configs: [dev, bad, { ...build, cwd: '../out' }],
      platform: 'linux',
      assertConfigCwd: async (_p, cwd) => {
        if (cwd === '../out') throw new Error('outside')
      },
      store: s
    })
    expect(out).toEqual({ ok: false, errors: [{ id: 'user:3', reason: 'INVALID_CONFIG' }, { id: 'user:2', reason: 'INVALID_CWD' }] })
    expect(s.save).not.toHaveBeenCalled()
  })

  it('refuses seed ids and duplicate ids', async () => {
    const s = store()
    const out = await saveConfigsBatch({
      projectPath: '/p',
      configs: [{ ...dev, id: 'seed:npm:dev' }, build, { ...build, name: 'again' }],
      platform: 'linux',
      assertConfigCwd: cwdOk,
      store: s
    })
    expect(out).toEqual({
      ok: false,
      errors: [
        { id: 'seed:npm:dev', reason: 'INVALID_CONFIG' },
        { id: 'user:2', reason: 'INVALID_CONFIG' },
        { id: 'user:2', reason: 'INVALID_CONFIG' }
      ]
    })
    expect(s.save).not.toHaveBeenCalled()
  })

  // An incomplete configuration is stored (＋ creates one with its required field empty); run.start is
  // what refuses to run it, by name
  it('accepts an incomplete configuration', async () => {
    const out = await saveConfigsBatch({ projectPath: '/p', configs: [{ id: 'user:4', name: 'new', type: 'npm', script: '' }], platform: 'linux', assertConfigCwd: cwdOk, store: store() })
    expect(out.ok).toBe(true)
  })

  describe('the win32 scan', () => {
    const risky: RunConfig = { ...dev, args: '--flag=a&b' }

    it('rejects a command-bound field holding a character cmd.exe interprets', async () => {
      const out = await saveConfigsBatch({ projectPath: '/p', configs: [risky], platform: 'win32', assertConfigCwd: cwdOk, store: store() })
      expect(out).toEqual({ ok: false, errors: [{ id: 'user:1', reason: 'UNSAFE_VALUE' }] })
    })

    it('runs only on win32', async () => {
      const out = await saveConfigsBatch({ projectPath: '/p', configs: [risky], platform: 'linux', assertConfigCwd: cwdOk, store: store() })
      expect(out.ok).toBe(true)
    })

    it('skips shell configurations and the fields that never reach the command', async () => {
      const shell: RunConfig = { id: 'user:5', name: 'sh & co', type: 'shell', command: 'echo a & echo b' }
      const named: RunConfig = { ...dev, name: 'build & test', env: { A: 'x|y' }, cwd: 'a&b' }
      const out = await saveConfigsBatch({ projectPath: '/p', configs: [shell, named], platform: 'win32', assertConfigCwd: cwdOk, store: store() })
      expect(out.ok).toBe(true)
    })
  })
})
