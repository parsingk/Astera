import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProjectUnderstanding } from '../../core/understanding/types'
import { UnderstandingStore } from './store'

let dir: string
let file: string

const sample: ProjectUnderstanding = {
  features: [
    { id: 'auth', name: '인증', summary: 'Google 로그인', status: 'up-to-date', updatedAt: '2026-08-27T00:00:00.000Z', evidenceCount: 6 }
  ],
  explanations: {},
  recentChanges: []
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hiw-'))
  file = path.join(dir, 'understanding.json')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('UnderstandingStore', () => {
  it('파일이 없으면 빈 상태로 시작한다', async () => {
    const s = new UnderstandingStore(file)
    expect((await s.load()).recovered).toBe(false)
    expect(s.get('C:/p')).toBeUndefined()
  })

  it('쓰고 다시 읽으면 같다', async () => {
    const a = new UnderstandingStore(file)
    await a.load()
    await a.set('C:/p', sample)

    const b = new UnderstandingStore(file)
    await b.load()
    expect(b.get('C:/p')).toEqual(sample)
  })

  it('프로젝트끼리 섞이지 않는다', async () => {
    const s = new UnderstandingStore(file)
    await s.load()
    await s.set('C:/a', sample)
    await s.set('C:/b', { ...sample, features: [] })
    expect(s.get('C:/a')!.features).toHaveLength(1)
    expect(s.get('C:/b')!.features).toHaveLength(0)
  })

  it('지우면 사라진다', async () => {
    const s = new UnderstandingStore(file)
    await s.load()
    await s.set('C:/p', sample)
    await s.remove('C:/p')
    expect(s.get('C:/p')).toBeUndefined()
  })

  it('깨진 파일은 .bak 으로 물리고 빈 상태로 시작한다', async () => {
    await fs.writeFile(file, '{ not json', 'utf8')
    const s = new UnderstandingStore(file)
    expect((await s.load()).recovered).toBe(true)
    expect(s.get('C:/p')).toBeUndefined()
    await expect(fs.readFile(file + '.bak', 'utf8')).resolves.toBe('{ not json')
  })

  it('모양이 틀린 파일도 같은 취급이다', async () => {
    await fs.writeFile(file, JSON.stringify({ projects: 'nope' }), 'utf8')
    const s = new UnderstandingStore(file)
    expect((await s.load()).recovered).toBe(true)
  })
})
