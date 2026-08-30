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

/** 설계 §9 의 ProjectGitSnapshot — "Astera 가 마지막으로 알던 git 상태" */
const snapshot = {
  projectPath: 'D:\\p',
  branch: 'main',
  head: 'abc',
  capturedAt: '2026-08-29T10:00:00.000Z'
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

  // 이 값이 메모리에만 있으면 앱이 꺼져 있던 동안의 pull·브랜치 전환이 통째로 사라진다
  // (설계 §9, EG §41-10·§42-17). 디스크 왕복이 그 전제다.
  it('git 스냅샷도 함께 저장되고 다시 읽힌다', async () => {
    const a = new WorkUnitStore(file)
    await a.load()
    await a.set('D:\\p', { ...sample, gitSnapshot: snapshot })

    const b = new WorkUnitStore(file)
    await b.load()
    expect(b.get('D:\\p')!.gitSnapshot).toEqual(snapshot)
  })

  // **선택 필드다.** 이 브랜치를 쓰던 사용자의 디스크에는 이 필드가 없는 workUnits.json 이 이미
  // 있고, 필수로 두면 그 파일이 통째로 .bak 으로 밀린다. 있을 때 보는 것은 "객체인가" 하나뿐이다 —
  // 원소 모양을 보지 않는 이 파일의 정책 그대로다.
  it('gitSnapshot 은 없어도 되고, 있으면 객체여야 한다', async () => {
    await fs.writeFile(file, JSON.stringify({ projects: { 'D:\\p': sample } }), 'utf8')
    expect((await new WorkUnitStore(file).load()).recovered).toBe(false)

    await fs.writeFile(
      file,
      JSON.stringify({ projects: { 'D:\\p': { ...sample, gitSnapshot: 'nope' } } }),
      'utf8'
    )
    expect((await new WorkUnitStore(file).load()).recovered).toBe(true)
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
