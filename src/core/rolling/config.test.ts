import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RollConfigStore, hostRollConfigPath, readRollConfigKey } from './config'
import { isSamePath } from '../files/tree'

let tmp: string
let store: RollConfigStore

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-rollcfg-'))
  store = new RollConfigStore(path.join(tmp, 'rolling.json'))
  await store.load()
})

describe('RollConfigStore', () => {
  it('set한 설정을 get으로 돌려준다', async () => {
    await store.set('sess-1', { accountIds: ['a', 'b'], prompt: '이어서' })
    expect(store.get('sess-1')).toEqual({ accountIds: ['a', 'b'], prompt: '이어서' })
  })

  it('없는 키는 null', () => {
    expect(store.get('nope')).toBeNull()
  })

  it('재로드 후에도 유지된다', async () => {
    await store.set('sess-1', { accountIds: ['a'], prompt: 'p' })
    const again = new RollConfigStore(path.join(tmp, 'rolling.json'))
    await again.load()
    expect(again.get('sess-1')).toEqual({ accountIds: ['a'], prompt: 'p' })
  })

  it('같은 키를 다시 set하면 덮어쓴다', async () => {
    await store.set('s', { accountIds: ['a'] })
    await store.set('s', { accountIds: ['b', 'c'] })
    expect(store.get('s')).toEqual({ accountIds: ['b', 'c'] })
  })

  it('손상된 rolling.json은 .bak으로 보존하고 빈 맵으로 복구한다', async () => {
    const file = path.join(tmp, 'broken.json')
    await fs.writeFile(file, '{not json', 'utf8')
    const broken = new RollConfigStore(file)
    const { recovered } = await broken.load()
    expect(recovered).toBe(true)
    expect(broken.get('any')).toBeNull()
    expect(await fs.readFile(file + '.bak', 'utf8')).toBe('{not json')
  })

  it('파일이 없으면 빈 맵으로 시작한다', async () => {
    const fresh = new RollConfigStore(path.join(tmp, 'absent.json'))
    const { recovered } = await fresh.load()
    expect(recovered).toBe(false)
    expect(fresh.get('any')).toBeNull()
  })
})

describe('the Host’s roll config file (S6 R9)', () => {
  it('lives under host/ in the profile, and one key reads back fresh', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-rollcfg-'))
    try {
      const file = hostRollConfigPath(dir)
      expect(isSamePath(path.dirname(file), path.join(dir, 'host'))).toBe(true)
      expect(await readRollConfigKey(file, 'k')).toBeNull()
      const store = new RollConfigStore(file)
      await store.load()
      await store.set('k', { accountIds: ['a1', 'a2'], prompt: 'go on' })
      expect(await readRollConfigKey(file, 'k')).toEqual({ accountIds: ['a1', 'a2'], prompt: 'go on' })
      await fs.writeFile(file, '{ damaged')
      expect(await readRollConfigKey(file, 'k')).toBeNull()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

// Chat takeover e2e: the Host's claude and codex chains restored together wrote rolling.json at once,
// and one tmp-to-file rename failed with EPERM on Windows. Writes to a file go one at a time, a set made
// while one waits rides along with it, and a locked rename is tried again.
describe('RollConfigStore — concurrent writes (chat takeover e2e E1)', () => {
  const file = () => path.join(tmp, 'rolling.json')

  it('never renames onto the file twice at once, and keeps every set', async () => {
    let inFlight = 0
    let most = 0
    let renames = 0
    const rename = async (from: string, to: string): Promise<void> => {
      inFlight += 1
      renames += 1
      most = Math.max(most, inFlight)
      await new Promise((r) => setTimeout(r, 15))
      await fs.rename(from, to)
      inFlight -= 1
    }
    const s = new RollConfigStore(file(), { rename })
    await s.load()
    const first = s.set('claude-1', { accountIds: ['a'] })
    await new Promise((r) => setTimeout(r, 5)) // the first write is in its rename now
    await Promise.all([first, s.set('codex-1', { accountIds: ['b'] }), s.set('codex-2', { accountIds: ['c'] })])
    expect(most).toBe(1)
    // The first write, then one more carrying both sets that waited behind it.
    expect(renames).toBe(2)
    const again = new RollConfigStore(file())
    await again.load()
    expect(again.get('claude-1')).toEqual({ accountIds: ['a'] })
    expect(again.get('codex-1')).toEqual({ accountIds: ['b'] })
    expect(again.get('codex-2')).toEqual({ accountIds: ['c'] })
  })

  it('serialises two stores on one file too', async () => {
    let inFlight = 0
    let most = 0
    const rename = async (from: string, to: string): Promise<void> => {
      inFlight += 1
      most = Math.max(most, inFlight)
      await new Promise((r) => setTimeout(r, 15))
      await fs.rename(from, to)
      inFlight -= 1
    }
    const a = new RollConfigStore(file(), { rename })
    const b = new RollConfigStore(file(), { rename })
    await Promise.all([a.set('k1', { accountIds: ['a'] }), b.set('k2', { accountIds: ['b'] })])
    expect(most).toBe(1)
  })

  it.each(['EPERM', 'EBUSY'])('tries a rename refused with %s again, and succeeds', async (code) => {
    let calls = 0
    const rename = async (from: string, to: string): Promise<void> => {
      calls += 1
      if (calls <= 2) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code })
      await fs.rename(from, to)
    }
    const s = new RollConfigStore(file(), { rename, retryDelayMs: 1 })
    await s.set('k', { accountIds: ['a'] })
    expect(calls).toBe(3)
    expect(await readRollConfigKey(file(), 'k')).toEqual({ accountIds: ['a'] })
  })

  it('gives up after a few tries, removes its tmp file, and the next set still writes', async () => {
    let fail = true
    const rename = async (from: string, to: string): Promise<void> => {
      if (fail) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      await fs.rename(from, to)
    }
    const s = new RollConfigStore(file(), { rename, retryDelayMs: 1 })
    await expect(s.set('k', { accountIds: ['a'] })).rejects.toThrow(/EPERM/)
    expect((await fs.readdir(tmp)).filter((f) => f.endsWith('.tmp'))).toEqual([])
    fail = false
    await s.set('k2', { accountIds: ['b'] })
    expect(await readRollConfigKey(file(), 'k2')).toEqual({ accountIds: ['b'] })
  })

  it('does not retry another error', async () => {
    let calls = 0
    const rename = async (): Promise<void> => {
      calls += 1
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
    }
    const s = new RollConfigStore(file(), { rename, retryDelayMs: 1 })
    await expect(s.set('k', { accountIds: ['a'] })).rejects.toThrow(/ENOSPC/)
    expect(calls).toBe(1)
  })
})
