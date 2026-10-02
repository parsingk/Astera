import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProjectUnderstanding } from './types'
import { UnderstandingStore } from './store'

let dir: string
let file: string

const sample: ProjectUnderstanding = { records: [] }

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

  it('saves through a temp file of its own, named for its pid, and leaves only the target behind', async () => {
    const s = new UnderstandingStore(file)
    await s.load()
    const written: string[] = []
    const renamed: string[] = []
    const write = vi.spyOn(fs, 'writeFile')
    const rename = vi.spyOn(fs, 'rename')
    try {
      await s.set('C:/p', sample)
      written.push(...write.mock.calls.map((c) => String(c[0])))
      renamed.push(...rename.mock.calls.map((c) => `${String(c[0])} -> ${String(c[1])}`))
    } finally {
      write.mockRestore()
      rename.mockRestore()
    }
    const tmp = `${file}.${process.pid}.tmp`
    expect(written).toEqual([tmp])
    expect(renamed).toEqual([`${tmp} -> ${file}`])
    expect(await fs.readdir(dir)).toEqual(['understanding.json'])
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ projects: { 'C:/p': sample } })
  })

  it('프로젝트끼리 섞이지 않는다', async () => {
    const s = new UnderstandingStore(file)
    await s.load()
    await s.set('C:/a', sample)
    await s.set('C:/b', {
      records: [
        {
          id: 'x',
          at: new Date().toISOString(),
          source: { kind: 'session', sessionId: 's', label: 'label' },
          request: 'r',
          changedFiles: [],
          git: { startHead: null, endHead: null },
          status: 'ready'
        }
      ]
    })
    expect(s.get('C:/a')!.records).toHaveLength(0)
    expect(s.get('C:/b')!.records).toHaveLength(1)
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

  it('rides out a rename refused while another process reads the file (EPERM on win32)', async () => {
    const s = new UnderstandingStore(file)
    await s.load()
    const busy = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(busy)
    try {
      await s.set('C:/p', sample)
    } finally {
      rename.mockRestore()
    }
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ projects: { 'C:/p': sample } })
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

  it('앱이 죽으며 남은 generating 은 다시 켤 때 풀린다', async () => {
    const a = new UnderstandingStore(file)
    await a.load()
    await a.set('C:/p', {
      records: [
        { id: 'r1', at: 'x', source: { kind: 'session', sessionId: 's', label: 'l' }, request: 'q',
          changedFiles: [], git: { startHead: null, endHead: null }, status: 'generating' }
      ]
    })
    const b = new UnderstandingStore(file)
    await b.load()
    expect(b.get('C:/p')!.records[0].status).toBe('failed')
    expect(b.get('C:/p')!.records[0].reason).toBe('INTERRUPTED')
  })

  // E1 Task 2 review I1: two processes may write this file one after the other (the Host and an older
  // app), so a write starts from the file, not from memory. refresh() is that read, and only when the
  // file is not the one this store last loaded or saved.
  describe('refresh', () => {
    const generating: ProjectUnderstanding = {
      records: [
        { id: 'r1', at: 'x', source: { kind: 'session', sessionId: 's', label: 'l' }, request: 'q',
          changedFiles: [], git: { startHead: null, endHead: null }, status: 'generating' }
      ]
    }

    it('does not reload after its own save, or with no file at all', async () => {
      const s = new UnderstandingStore(file)
      await s.load()
      expect(await s.refresh()).toBe(false)
      await s.set('C:/p', sample)
      expect(await s.refresh()).toBe(false)
      expect(s.get('C:/p')).toEqual(sample)
    })

    it('does not reload after its own load', async () => {
      await new UnderstandingStore(file).set('C:/p', sample)
      const s = new UnderstandingStore(file)
      await s.load()
      expect(await s.refresh()).toBe(false)
    })

    it('adopts a file another process wrote, without marking its generating records interrupted', async () => {
      const a = new UnderstandingStore(file)
      await a.load()
      await a.set('C:/p', sample)
      const other = new UnderstandingStore(file)
      await other.load()
      await other.set('C:/q', generating)
      expect(await a.refresh()).toBe(true)
      expect(a.get('C:/q')!.records[0].status).toBe('generating')
      expect(a.get('C:/p')).toEqual(sample)
    })

    it('waits for its own queued save instead of reading the file under it', async () => {
      const s = new UnderstandingStore(file)
      await s.load()
      void s.set('C:/p', generating)
      expect(await s.refresh()).toBe(false)
      expect(s.get('C:/p')).toEqual(generating)
      const b = new UnderstandingStore(file)
      await b.load()
      expect(b.get('C:/p')).toBeDefined()
    })

    it('keeps what it holds when the file it would adopt is not valid', async () => {
      const s = new UnderstandingStore(file)
      await s.load()
      await s.set('C:/p', sample)
      await fs.writeFile(file, '{ broken', 'utf8')
      expect(await s.refresh()).toBe(false)
      expect(s.get('C:/p')).toEqual(sample)
    })

    // Task 2 re-review: a refresh outside the pipeline's queue (the Host's regenerate) must not adopt the
    // file over a write this store made while the refresh was reading.
    it('does not adopt the file over a set made while it was reading', async () => {
      const s = new UnderstandingStore(file)
      await s.load()
      await s.set('C:/p', sample)
      const other = new UnderstandingStore(file)
      await other.load()
      await other.set('C:/q', generating)
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
      try {
        const refreshed = s.refresh()
        await started
        await s.set('C:/r', sample)
        release()
        await refreshed
      } finally {
        spy.mockRestore()
      }
      expect(s.get('C:/r')).toEqual(sample)
    })
  })
})
