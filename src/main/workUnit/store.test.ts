import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WorkUnitStore, type WorkUnitState } from './store'

let dir: string
let file: string

const sample: WorkUnitState = {
  units: [
    {
      id: 'wu-1',
      sessionId: 's-1',
      projectPath: 'D:\\p',
      title: '로그인 기능 만들어줘',
      status: 'active',
      startedAt: '2026-08-29T10:00:00.000Z',
      firstMessageIndex: 0,
      messageCount: 1,
      git: { startHead: 'abc', observedChangedFiles: [] },
      encounteredExternalGitChangeIds: []
    }
  ],
  cursors: [{ sessionId: 's-1', filePath: 'C:\\t.jsonl', offset: 120, sizeAtRead: 120 }],
  messages: [{ sessionId: 's-1', index: 0, at: '2026-08-29T10:00:00.000Z', text: '로그인 기능 만들어줘' }],
  externalGitChanges: []
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-wu-'))
  file = path.join(dir, 'workUnits.json')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('WorkUnitStore', () => {
  it('파일이 없으면 빈 상태로 시작한다', async () => {
    const s = new WorkUnitStore(file)
    expect((await s.load()).recovered).toBe(false)
    expect(s.get('D:\\p')).toBeUndefined()
  })

  it('쓰고 다시 읽으면 같다', async () => {
    const a = new WorkUnitStore(file)
    await a.load()
    await a.set('D:\\p', sample)

    const b = new WorkUnitStore(file)
    await b.load()
    expect(b.get('D:\\p')).toEqual(sample)
  })

  it('프로젝트끼리 섞이지 않는다', async () => {
    const s = new WorkUnitStore(file)
    await s.load()
    await s.set('D:\\a', sample)
    await s.set('D:\\b', { units: [], cursors: [], messages: [], externalGitChanges: [] })
    expect(s.get('D:\\a')!.units).toHaveLength(1)
    expect(s.get('D:\\b')!.units).toHaveLength(0)
  })

  it('깨진 파일은 .bak 으로 물리고 빈 상태로 시작한다', async () => {
    await fs.writeFile(file, '{ not json', 'utf8')
    const s = new WorkUnitStore(file)
    expect((await s.load()).recovered).toBe(true)
    await expect(fs.readFile(file + '.bak', 'utf8')).resolves.toBe('{ not json')
  })

  it('모양이 틀린 파일도 같은 취급이다', async () => {
    await fs.writeFile(file, JSON.stringify({ projects: { 'D:\\p': { units: 'nope' } } }), 'utf8')
    const s = new WorkUnitStore(file)
    expect((await s.load()).recovered).toBe(true)
  })

  // understanding.json 저장소가 실제로 겪은 두 버그다. 되풀이하지 않는다.
  it('읽을 수 없는 파일은 "아직 없음"이 아니다 — 다음 쓰기가 덮어쓰면 안 된다', async () => {
    await fs.mkdir(file) // 파일 자리에 디렉터리. readFile 이 던지는 코드는 플랫폼마다 다르지만
    const s = new WorkUnitStore(file) // ENOENT 가 아니라는 점은 어디서나 같다
    expect((await s.load()).recovered).toBe(true)
  })

  it('쓰기가 한 번 실패해도 다음 쓰기는 진행된다 — 큐가 얼어붙지 않는다', async () => {
    const nested = path.join(dir, 'sub', 'workUnits.json')
    await fs.writeFile(path.join(dir, 'sub'), 'blocker', 'utf8')
    const s = new WorkUnitStore(nested)
    await s.load()
    await expect(s.set('D:\\p', sample)).rejects.toThrow()

    await fs.rm(path.join(dir, 'sub'))
    await s.set('D:\\q', sample)

    const b = new WorkUnitStore(nested)
    await b.load()
    expect(b.get('D:\\q')).toEqual(sample)
  })
})
