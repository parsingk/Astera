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
