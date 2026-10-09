import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WorkUnitStore, type WorkUnitState } from './store'

/** Audit U-1: makes the store's file answer EBUSY to every read until the returned function is called, the way a file
 *  another process is renaming answers on win32. */
const busyWhileLoading = (target: string): (() => void) => {
  const real = fs.readFile.bind(fs)
  const spy = vi.spyOn(fs, 'readFile').mockImplementation(((p: unknown, ...rest: unknown[]) =>
    String(p) === target ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) : (real as (...a: unknown[]) => Promise<unknown>)(p, ...rest)) as typeof fs.readFile)
  return () => spy.mockRestore()
}


let dir: string
let file: string

const sample: WorkUnitState = {
  units: [
    {
      id: 'wu-1',
      sessionId: 's-1',
      projectPath: 'D:\\p',
      objective: '로그인 기능 만들어줘',
      status: 'active',
      startedAt: '2026-08-29T10:00:00.000Z',
      git: { startHead: 'abc', observedChangedFiles: [] },
      encounteredExternalGitChangeIds: []
    }
  ],
  cursors: [{ sessionId: 's-1', filePath: 'C:\\t.jsonl', offset: 120, sizeAtRead: 120 }],
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
  it('a file it could not read is not written over: the next write reads it again first, and keeps what it held', async () => {
    const a = new WorkUnitStore(file)
    await a.load()
    await a.set('kept', sample)
    const b = new WorkUnitStore(file)
    const release = busyWhileLoading(file)
    expect((await b.load()).recovered).toBe(false)
    release()
    await b.set('new', sample)
    const c = new WorkUnitStore(file)
    await c.load()
    expect(c.get('kept')).toEqual(sample)
    expect(c.get('new')).toEqual(sample)
  })
  // Final review M-2: a file gone by the time a write read it again kept what memory held; load empties memory for that
  // case on purpose (E2 §6), and the re-read does the same.
  it('a write after an unreadable load, with the file gone meanwhile, starts from empty', async () => {
    const s = new WorkUnitStore(file)
    await s.set('old', sample)
    const release = busyWhileLoading(file)
    await s.load()
    release()
    await fs.rm(file)
    await s.set('new', sample)
    expect(s.projectPaths()).toEqual(['new'])
  })
  it('파일이 없으면 빈 상태로 시작한다', async () => {
    const s = new WorkUnitStore(file)
    expect((await s.load()).recovered).toBe(false)
    expect(s.get('D:\\p')).toBeUndefined()
  })

  it('a load that finds no file starts from empty, not from what this store held before (E2 §6 reader to writer)', async () => {
    const s = new WorkUnitStore(file)
    await s.set('proj', sample)
    await fs.rm(file)
    expect(await s.load()).toEqual({ recovered: false })
    expect(s.get('proj')).toBeUndefined()
    expect(s.projectPaths()).toEqual([])
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
    await s.set('D:\\b', { units: [], cursors: [], externalGitChanges: [] })
    expect(s.get('D:\\a')!.units).toHaveLength(1)
    expect(s.get('D:\\b')!.units).toHaveLength(0)
  })

  // The one thing seed()'s orphan sweep relies on — WorkUnitStore has no other way to hand out its keys
  it('projectPaths 는 저장된 프로젝트 전부를 돌려준다', async () => {
    const s = new WorkUnitStore(file)
    await s.load()
    expect(s.projectPaths()).toEqual([])

    await s.set('D:\\a', sample)
    await s.set('D:\\b', { units: [], cursors: [], externalGitChanges: [] })
    expect(s.projectPaths().sort()).toEqual(['D:\\a', 'D:\\b'])
  })

  // 이 값이 메모리에만 있으면 앱이 꺼져 있던 동안의 pull·브랜치 전환이 통째로 사라진다
  // (설계 §9, EG §41-10·§42-17). 디스크 왕복이 그 전제다.
  //
  // **이 테스트가 지키는 것은 타입이다.** 저장소는 모르는 키도 그대로 실어 나르므로, 필드를 지워도
  // 여기는 초록으로 남고 `tsc` 만 잡는다(실측). 런타임 약속 — 한 파일을 두 수집기가 이어받아 읽는다 —
  // 은 collector.test.ts 의 '꺼져 있는 동안 옮겨진 HEAD 가 다시 켠 첫 회차에 잡힌다' 가 지킨다.
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
    // Not damage either (audit U-1): nothing was read, so nothing is kept aside or healed, and a write is refused.
    expect((await s.load()).recovered).toBe(false)
    await expect(s.set('D:\\p', sample)).rejects.toThrow(/could not be read/)
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

  // Requiring the field would send every file written before this change to .bak
  it('옛 파일의 messages 는 가드를 통과하고 다음 저장에서 사라진다', async () => {
    const legacy = {
      ...sample,
      messages: [{ sessionId: 's-1', index: 0, at: '2026-08-29T10:00:00.000Z', text: '로그인 기능 만들어줘' }]
    }
    await fs.writeFile(file, JSON.stringify({ projects: { 'D:\\p': legacy } }), 'utf8')

    const s = new WorkUnitStore(file)
    expect((await s.load()).recovered).toBe(false) // 가드를 통과했다

    await s.set('D:\\p', sample) // 다음 저장은 새 모양이다 — messages 가 없다
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(raw.projects['D:\\p'].messages).toBeUndefined()
  })

  it('completed-candidate 는 중단으로 바뀌어 사람 앞에 선다', async () => {
    const legacyUnit = { ...sample.units[0], status: 'completed-candidate' }
    await fs.writeFile(
      file,
      JSON.stringify({ projects: { 'D:\\p': { ...sample, units: [legacyUnit] } } }),
      'utf8'
    )

    const s = new WorkUnitStore(file)
    await s.load()
    const u = s.get('D:\\p')!.units[0]
    expect(u.status).toBe('interrupted')
    expect(u.reason).toBe('INTERRUPTED_BY_APP_UPGRADE')
  })

  it('abandoned 는 버린다 — 하류가 한 번도 읽지 않은 상태였다', async () => {
    const legacyUnit = { ...sample.units[0], status: 'abandoned' }
    await fs.writeFile(
      file,
      JSON.stringify({ projects: { 'D:\\p': { ...sample, units: [legacyUnit] } } }),
      'utf8'
    )

    const s = new WorkUnitStore(file)
    await s.load()
    expect(s.get('D:\\p')!.units).toHaveLength(0)
  })

  it('title 만 있는 옛 Unit 은 그것을 objective 로 든다', async () => {
    const legacyUnit: Record<string, unknown> = { ...sample.units[0] }
    delete legacyUnit.objective
    legacyUnit.title = '옛 제목'
    await fs.writeFile(
      file,
      JSON.stringify({ projects: { 'D:\\p': { ...sample, units: [legacyUnit] } } }),
      'utf8'
    )

    const s = new WorkUnitStore(file)
    await s.load()
    expect(s.get('D:\\p')!.units[0].objective).toBe('옛 제목')
  })

  // E2 §3: the Host and an older app can each hold a store over this file, so a save goes through a
  // temp file of this process's own (E1's UnderstandingStore rule).
  it('saves through a temp file of its own, named for its pid, and leaves only the target behind', async () => {
    const s = new WorkUnitStore(file)
    await s.load()
    const write = vi.spyOn(fs, 'writeFile')
    const rename = vi.spyOn(fs, 'rename')
    let written: string[] = []
    let renamed: string[] = []
    try {
      await s.set('D:\\p', sample)
      written = write.mock.calls.map((c) => String(c[0]))
      renamed = rename.mock.calls.map((c) => `${String(c[0])} -> ${String(c[1])}`)
    } finally {
      write.mockRestore()
      rename.mockRestore()
    }
    const tmp = `${file}.${process.pid}.tmp`
    expect(written).toEqual([tmp])
    expect(renamed).toEqual([`${tmp} -> ${file}`])
    expect(await fs.readdir(dir)).toEqual(['workUnits.json'])
  })

  // Second pass C2-1: the whole store is rewritten as sessions work, and indentation made each rewrite a good third
  // larger for no reader (every reader is a plain JSON.parse), as the orchestration store found.
  it('writes the file compact, on one line', async () => {
    const s = new WorkUnitStore(file)
    await s.load()
    await s.set('D:\\p', sample)
    expect((await fs.readFile(file, 'utf8')).includes('\n')).toBe(false)
  })

  it('rides out a rename refused while another process reads the file (EPERM on win32)', async () => {
    const s = new WorkUnitStore(file)
    await s.load()
    const busy = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(busy)
    try {
      await s.set('D:\\p', sample)
    } finally {
      rename.mockRestore()
    }
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ projects: { 'D:\\p': sample } })
  })

  it('removes its own temp file when the rename fails for good', async () => {
    const s = new WorkUnitStore(file)
    await s.load()
    const busy = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(busy)
    try {
      await expect(s.set('D:\\p', sample)).rejects.toThrow('EPERM')
    } finally {
      rename.mockRestore()
    }
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('settled resolves once the saves queued so far have landed, and never rejects', async () => {
    const s = new WorkUnitStore(file)
    await s.load()
    void s.set('D:\\p', sample)
    await s.settled()
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ projects: { 'D:\\p': sample } })
  })

  // E2 §3: refresh before a write, against what another process wrote meanwhile (E1's refresh).
  describe('refresh', () => {
    const empty: WorkUnitState = { units: [], cursors: [], externalGitChanges: [] }

    it('does not reload after its own save, its own load, or with no file at all', async () => {
      const s = new WorkUnitStore(file)
      await s.load()
      expect(await s.refresh()).toBe(false)
      await s.set('D:\\p', sample)
      expect(await s.refresh()).toBe(false)
      const b = new WorkUnitStore(file)
      await b.load()
      expect(await b.refresh()).toBe(false)
    })

    it('adopts a file another process wrote', async () => {
      const a = new WorkUnitStore(file)
      await a.load()
      await a.set('D:\\p', sample)
      const other = new WorkUnitStore(file)
      await other.load()
      await other.set('D:\\q', empty)
      expect(await a.refresh()).toBe(true)
      expect(a.get('D:\\q')).toEqual(empty)
      expect(a.get('D:\\p')).toEqual(sample)
    })

    // A Host stopped while an app was the writer, and the file was removed meanwhile: what it still held
    // must not come back in the file its next allowed write creates.
    it('starts over empty when the file it last saw is gone, so its next write does not bring old projects back', async () => {
      const s = new WorkUnitStore(file)
      await s.load()
      await s.set('D:\\p', sample)
      await fs.rm(file)
      expect(await s.refresh()).toBe(true)
      expect(s.get('D:\\p')).toBeUndefined()
      await s.set('D:\\q', empty)
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ projects: { 'D:\\q': empty } })
    })

    it('waits for its own queued save instead of reading the file under it', async () => {
      const s = new WorkUnitStore(file)
      await s.load()
      void s.set('D:\\p', sample)
      expect(await s.refresh()).toBe(false)
      expect(s.get('D:\\p')).toEqual(sample)
    })

    it('keeps what it holds when the file it would adopt is not valid', async () => {
      const s = new WorkUnitStore(file)
      await s.load()
      await s.set('D:\\p', sample)
      await fs.writeFile(file, '{ broken', 'utf8')
      expect(await s.refresh()).toBe(false)
      expect(s.get('D:\\p')).toEqual(sample)
    })

    it('does not adopt the file over a set made while it was reading', async () => {
      const s = new WorkUnitStore(file)
      await s.load()
      await s.set('D:\\p', sample)
      const other = new WorkUnitStore(file)
      await other.load()
      await other.set('D:\\q', empty)
      const real = fs.readFile.bind(fs)
      let reading: () => void = () => {}
      const started = new Promise<void>((r) => (reading = r))
      let release: () => void = () => {}
      const gate = new Promise<void>((r) => (release = r))
      const spy = vi.spyOn(fs, 'readFile').mockImplementationOnce((async (...args: Parameters<typeof fs.readFile>) => {
        const text = await real(...args)
        reading()
        await gate
        return text
      }) as typeof fs.readFile)
      let refreshed: boolean
      try {
        const p = s.refresh()
        await started
        void s.set('D:\\r', empty)
        release()
        refreshed = await p
      } finally {
        spy.mockRestore()
      }
      expect(refreshed).toBe(false)
      expect(s.get('D:\\r')).toEqual(empty)
      // The set above is not awaited: its save must land before afterEach removes the folder under it.
      await s.settled()
    })
  })
})
