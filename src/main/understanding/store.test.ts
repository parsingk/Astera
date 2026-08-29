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

  it('읽을 수 없는 파일은 "아직 없음"이 아니다 — 다음 set() 이 조용히 덮어쓰면 안 된다', async () => {
    // 파일 자리에 디렉터리를 둔다. readFile 이 던지는 코드는 플랫폼마다 다르지만(EISDIR/EPERM)
    // ENOENT 가 아니라는 점은 어디서나 같고, 이 테스트가 보는 것이 바로 그 구분이다
    await fs.mkdir(file)
    const s = new UnderstandingStore(file)
    expect((await s.load()).recovered).toBe(true)
  })

  it('쓰기가 한 번 실패해도 다음 쓰기는 진행된다 — 큐가 얼어붙지 않는다', async () => {
    // 부모 자리에 파일을 두면 mkdir 이 실패해 첫 쓰기가 거절된다
    const nested = path.join(dir, 'sub', 'understanding.json')
    await fs.writeFile(path.join(dir, 'sub'), 'blocker', 'utf8')
    const s = new UnderstandingStore(nested)
    await s.load()
    await expect(s.set('C:/p', sample)).rejects.toThrow()

    // 막고 있던 것을 치우면 다음 쓰기는 성공해야 한다
    await fs.rm(path.join(dir, 'sub'))
    await s.set('C:/q', sample)

    const b = new UnderstandingStore(nested)
    await b.load()
    expect(b.get('C:/q')).toEqual(sample)
    // 첫 set() 의 상태도 메모리에 남아 있었으므로 함께 실렸다
    expect(b.get('C:/p')).toEqual(sample)
  })
})
