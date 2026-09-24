import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionCwdCache } from './sessionCwdCache'

let tmp: string
const filePath = (): string => path.join(tmp, 'session-cwd.json')

/** A session file path that is absolute **on this platform**. Hardcoding `D:\a\x.jsonl` reads as an
 *  absolute path only on win32; on POSIX path.resolve prepends the cwd and leaves the backslashes as
 *  characters, so two spellings of the same intent stopped matching and the suite went red on
 *  ubuntu/macos while passing on windows. */
const sessionPath = (...segments: string[]): string =>
  path.join(process.platform === 'win32' ? 'D:\\' : '/', ...segments)

/** The on-disk key rule, duplicated on purpose — these tests assert the stored format, so deriving the
 *  key from the module under test would make them agree with it by construction. */
const keyOf = (p: string): string => path.resolve(p).toLowerCase()

// A cwd is only ever compared for equality, never resolved, so it stays a fixed win32-looking string
const CWD_A = 'D:\\proj\\alpha'
const CWD_B = 'D:\\proj\\beta'

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cwdcache-'))
})

describe('SessionCwdCache', () => {
  it('없는 파일을 load하면 빈 캐시로 시작한다 (전부 miss)', async () => {
    const c = new SessionCwdCache(filePath())
    expect(await c.load()).toEqual({ recovered: false })
    expect(c.get(sessionPath('a', 'x.jsonl'), 1, 2)).toBeUndefined()
  })

  it('set한 값을 같은 (mtime,size)로 되찾는다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    const p = sessionPath('a', 'x.jsonl')
    c.set(p, 100, 20, CWD_A)
    expect(c.get(p, 100, 20)).toBe(CWD_A)
  })

  it('cwd가 없는 파일(null)도 히트로 기억한다 — miss(undefined)와 구분된다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    c.set(sessionPath('a', 'noise.jsonl'), 100, 20, null)
    expect(c.get(sessionPath('a', 'noise.jsonl'), 100, 20)).toBeNull()
    expect(c.get(sessionPath('a', 'other.jsonl'), 100, 20)).toBeUndefined()
  })

  it('mtime이나 size가 달라지면 miss가 된다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    const p = sessionPath('a', 'x.jsonl')
    c.set(p, 100, 20, CWD_A)
    expect(c.get(p, 101, 20)).toBeUndefined()
    expect(c.get(p, 100, 21)).toBeUndefined()
  })

  it('win32 에서는 대소문자 표기가 달라도 같은 파일로 본다', async () => {
    const c = new SessionCwdCache(filePath(), 'win32')
    await c.load()
    const p = sessionPath('A', 'X.jsonl')
    c.set(p, 100, 20, CWD_A)
    expect(c.get(p.toLowerCase(), 100, 20)).toBe(CWD_A)
  })

  it('linux 에서는 대소문자만 다른 두 파일을 따로 기억한다', async () => {
    const c = new SessionCwdCache(filePath(), 'linux')
    await c.load()
    const p = sessionPath('A', 'X.jsonl')
    c.set(p, 100, 20, CWD_A)
    expect(c.get(sessionPath('A', 'x.jsonl'), 100, 20)).toBeUndefined()
  })

  // 반대 방향: 이 빌드가 적은 소문자 파일의 행은 옛 행과 구별되지 않아 대문자 형제의 조회도 그 행을
  // 본다. 그래도 적중은 (mtimeMs, size) 가 같아야 하므로, 다른 파일이면 빗나간다. 둘 다 같은 두
  // 파일 — 밀리초 이하까지 같은 mtime 과 같은 크기, 게다가 UUID 이름이 대소문자만 다른 것 — 만 남는다.
  it('linux: 이 빌드가 적은 소문자 파일의 행은 대문자 형제의 (mtime, size) 로는 빗나간다', async () => {
    const c = new SessionCwdCache(filePath(), 'linux')
    await c.load()
    const lower = path.join(path.resolve(sessionPath('a')).toLowerCase(), 'x.jsonl')
    const upper = path.join(path.dirname(lower), 'X.jsonl')
    c.set(lower, 100, 20, CWD_A)
    expect(c.get(upper, 101, 20)).toBeUndefined()
    expect(c.get(upper, 100, 21)).toBeUndefined()
    await c.flush()
    const again = new SessionCwdCache(filePath(), 'linux')
    await again.load()
    expect(again.get(upper, 101, 20)).toBeUndefined()
    expect(again.get(lower, 100, 20)).toBe(CWD_A)
  })

  it('linux: 예전 빌드가 소문자로 적은 키도 찾고, 새로 적는 키는 원래 철자다', async () => {
    const p = sessionPath('A', 'X.jsonl')
    await fs.writeFile(filePath(), JSON.stringify({ [keyOf(p)]: [100, 20, CWD_A] }), 'utf8')
    const c = new SessionCwdCache(filePath(), 'linux')
    await c.load()
    expect(c.get(p, 100, 20)).toBe(CWD_A)
    c.set(p, 200, 30, CWD_B)
    await c.flush()
    const stored = JSON.parse(await fs.readFile(filePath(), 'utf8')) as Record<string, unknown>
    expect(stored[path.resolve(p)]).toEqual([200, 30, CWD_B])
    expect(c.get(p, 200, 30)).toBe(CWD_B)
  })

  // 구분자를 무시하는 것은 path.resolve 가 win32 에서만 주는 성질이고, 두 표기가 실제로 섞여 들어오는
  // 곳도 win32 뿐이다 — POSIX 에서 백슬래시는 파일명에 쓸 수 있는 문자다. keyOf 주석의 "win32 first" 가
  // 뜻하는 범위가 여기다.
  it.skipIf(process.platform !== 'win32')('win32에선 구분자 표기가 달라도 같은 파일로 본다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    c.set('D:\\A\\X.jsonl', 100, 20, CWD_A)
    expect(c.get('d:/a/x.jsonl', 100, 20)).toBe(CWD_A)
  })

  it('flush한 내용을 다음 인스턴스가 load로 되찾는다', async () => {
    const p = sessionPath('a', 'x.jsonl')
    const first = new SessionCwdCache(filePath())
    await first.load()
    first.set(p, 100, 20, CWD_A)
    await first.flush()

    const second = new SessionCwdCache(filePath())
    expect(await second.load()).toEqual({ recovered: false })
    expect(second.get(p, 100, 20)).toBe(CWD_A)
  })

  it('바뀐 것이 없으면 파일을 쓰지 않는다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    await c.flush()
    await expect(fs.access(filePath())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('깨진 파일은 .bak을 남기고 빈 캐시로 복구한다', async () => {
    await fs.writeFile(filePath(), '{ this is not json', 'utf8')
    const c = new SessionCwdCache(filePath())
    expect(await c.load()).toEqual({ recovered: true })
    expect(c.get(sessionPath('a', 'x.jsonl'), 100, 20)).toBeUndefined()
    expect(await fs.readFile(filePath() + '.bak', 'utf8')).toBe('{ this is not json')
  })

  it('스키마가 깨진 행 하나는 버리고 나머지는 살린다', async () => {
    const good = sessionPath('a', 'good.jsonl')
    const bad = sessionPath('a', 'bad.jsonl')
    await fs.writeFile(
      filePath(),
      JSON.stringify({ [keyOf(good)]: [100, 20, CWD_A], [keyOf(bad)]: ['nope', 20, CWD_B] }),
      'utf8'
    )
    const c = new SessionCwdCache(filePath())
    expect(await c.load()).toEqual({ recovered: false })
    expect(c.get(good, 100, 20)).toBe(CWD_A)
    expect(c.get(bad, 100, 20)).toBeUndefined()
  })

  it('상한을 넘으면 mtime이 새로운 쪽을 남긴다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    // 10_000이 상한 — 넘겨서 오래된 쪽이 잘리는지 본다
    for (let i = 0; i < 10_050; i++) c.set(sessionPath('a', `f${i}.jsonl`), i, 1, `D:\\proj\\p${i}`)
    await c.flush()

    const reloaded = new SessionCwdCache(filePath())
    await reloaded.load()
    expect(reloaded.get(sessionPath('a', 'f10049.jsonl'), 10_049, 1)).toBe('D:\\proj\\p10049')
    expect(reloaded.get(sessionPath('a', 'f0.jsonl'), 0, 1)).toBeUndefined()
  })

  // Host 가 쓰는 모드다. 파일은 앱의 것이라 두 번째 프로세스가 쓰면 앱의 flush 와 엇갈린다.
  it('읽기 전용이면 읽어서 쓰되 파일은 건드리지 않는다', async () => {
    const known = sessionPath('a', 'known.jsonl')
    const text = JSON.stringify({ [keyOf(known)]: [100, 20, CWD_A] })
    await fs.writeFile(filePath(), text, 'utf8')
    const c = new SessionCwdCache(filePath(), process.platform, { readOnly: true })
    await c.load()
    expect(c.get(known, 100, 20)).toBe(CWD_A)
    c.set(sessionPath('a', 'fresh.jsonl'), 1, 2, CWD_B)
    await c.flush()
    expect(c.get(sessionPath('a', 'fresh.jsonl'), 1, 2)).toBe(CWD_B) // 메모리에는 남는다
    expect(await fs.readFile(filePath(), 'utf8')).toBe(text)
  })

  it('읽기 전용이면 깨진 파일에 .bak 도 만들지 않는다', async () => {
    await fs.writeFile(filePath(), '{ this is not json', 'utf8')
    const c = new SessionCwdCache(filePath(), process.platform, { readOnly: true })
    expect(await c.load()).toEqual({ recovered: true })
    c.set(sessionPath('a', 'x.jsonl'), 1, 2, CWD_A)
    await c.flush()
    expect(await fs.readdir(tmp)).toEqual(['session-cwd.json'])
    expect(await fs.readFile(filePath(), 'utf8')).toBe('{ this is not json')
  })
})
