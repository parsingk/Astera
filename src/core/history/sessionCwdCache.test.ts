import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionCwdCache } from './sessionCwdCache'

let tmp: string
const filePath = (): string => path.join(tmp, 'session-cwd.json')

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cwdcache-'))
})

describe('SessionCwdCache', () => {
  it('없는 파일을 load하면 빈 캐시로 시작한다 (전부 miss)', async () => {
    const c = new SessionCwdCache(filePath())
    expect(await c.load()).toEqual({ recovered: false })
    expect(c.get('D:\\a\\x.jsonl', 1, 2)).toBeUndefined()
  })

  it('set한 값을 같은 (mtime,size)로 되찾는다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    c.set('D:\\a\\x.jsonl', 100, 20, 'D:\\proj\\alpha')
    expect(c.get('D:\\a\\x.jsonl', 100, 20)).toBe('D:\\proj\\alpha')
  })

  it('cwd가 없는 파일(null)도 히트로 기억한다 — miss(undefined)와 구분된다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    c.set('D:\\a\\noise.jsonl', 100, 20, null)
    expect(c.get('D:\\a\\noise.jsonl', 100, 20)).toBeNull()
    expect(c.get('D:\\a\\other.jsonl', 100, 20)).toBeUndefined()
  })

  it('mtime이나 size가 달라지면 miss가 된다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    c.set('D:\\a\\x.jsonl', 100, 20, 'D:\\proj\\alpha')
    expect(c.get('D:\\a\\x.jsonl', 101, 20)).toBeUndefined()
    expect(c.get('D:\\a\\x.jsonl', 100, 21)).toBeUndefined()
  })

  it('경로 표기(대소문자·구분자)가 달라도 같은 파일로 본다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    c.set('D:\\A\\X.jsonl', 100, 20, 'D:\\proj\\alpha')
    expect(c.get('d:/a/x.jsonl', 100, 20)).toBe('D:\\proj\\alpha')
  })

  it('flush한 내용을 다음 인스턴스가 load로 되찾는다', async () => {
    const first = new SessionCwdCache(filePath())
    await first.load()
    first.set('D:\\a\\x.jsonl', 100, 20, 'D:\\proj\\alpha')
    await first.flush()

    const second = new SessionCwdCache(filePath())
    expect(await second.load()).toEqual({ recovered: false })
    expect(second.get('D:\\a\\x.jsonl', 100, 20)).toBe('D:\\proj\\alpha')
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
    expect(c.get('D:\\a\\x.jsonl', 100, 20)).toBeUndefined()
    expect(await fs.readFile(filePath() + '.bak', 'utf8')).toBe('{ this is not json')
  })

  it('스키마가 깨진 행 하나는 버리고 나머지는 살린다', async () => {
    await fs.writeFile(
      filePath(),
      JSON.stringify({
        'd:\\a\\good.jsonl': [100, 20, 'D:\\proj\\alpha'],
        'd:\\a\\bad.jsonl': ['nope', 20, 'D:\\proj\\beta']
      }),
      'utf8'
    )
    const c = new SessionCwdCache(filePath())
    expect(await c.load()).toEqual({ recovered: false })
    expect(c.get('D:\\a\\good.jsonl', 100, 20)).toBe('D:\\proj\\alpha')
    expect(c.get('D:\\a\\bad.jsonl', 100, 20)).toBeUndefined()
  })

  it('상한을 넘으면 mtime이 새로운 쪽을 남긴다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    // 10_000이 상한 — 넘겨서 오래된 쪽이 잘리는지 본다
    for (let i = 0; i < 10_050; i++) c.set(`D:\\a\\f${i}.jsonl`, i, 1, `D:\\proj\\p${i}`)
    await c.flush()

    const reloaded = new SessionCwdCache(filePath())
    await reloaded.load()
    expect(reloaded.get('D:\\a\\f10049.jsonl', 10_049, 1)).toBe('D:\\proj\\p10049')
    expect(reloaded.get('D:\\a\\f0.jsonl', 0, 1)).toBeUndefined()
  })
})
