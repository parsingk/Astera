import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { JsonlTail } from './jsonlTail'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'astera-jsonl-tail-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('JsonlTail', () => {
  it('완결된 줄만 돌려주고 미완결 조각은 다음 read로 넘긴다', async () => {
    const p = path.join(dir, 'a.jsonl')
    await writeFile(p, '{"a":1}\n{"b":2}\n{"c":3') // 마지막 줄 미완결
    const tail = new JsonlTail(p)
    const first = await tail.read()
    expect(first?.lines).toEqual(['{"a":1}', '{"b":2}'])
    expect(first?.restarted).toBe(false)

    await appendFile(p, '}\n{"d":4}\n') // 앞 조각이 완결되고 한 줄 더
    const second = await tail.read()
    expect(second?.lines).toEqual(['{"c":3}', '{"d":4}'])
  })

  it('새 줄이 없으면 빈 배열 (오류가 아니다)', async () => {
    const p = path.join(dir, 'b.jsonl')
    await writeFile(p, '{"a":1}\n')
    const tail = new JsonlTail(p)
    await tail.read()
    const again = await tail.read()
    expect(again).toEqual({ lines: [], restarted: false })
  })

  it('파일이 짧아지면 처음부터 다시 읽고 restarted를 알린다', async () => {
    const p = path.join(dir, 'c.jsonl')
    await writeFile(p, '{"a":1}\n{"b":2}\n')
    const tail = new JsonlTail(p)
    await tail.read()
    await writeFile(p, '{"z":9}\n') // 재생성 — 더 짧다
    const after = await tail.read()
    expect(after?.restarted).toBe(true)
    expect(after?.lines).toEqual(['{"z":9}'])
  })

  it('파일이 없으면 null (크래시 금지)', async () => {
    expect(await new JsonlTail(path.join(dir, 'nope.jsonl')).read()).toBeNull()
  })

  it('빈 줄과 공백 줄은 제외한다', async () => {
    const p = path.join(dir, 'e.jsonl')
    await writeFile(p, '{"a":1}\n\n   \n{"b":2}\n')
    expect((await new JsonlTail(p).read())?.lines).toEqual(['{"a":1}', '{"b":2}'])
  })

  // startAtEnd 옵션 — 기본값은 그대로(offset 0)라 위 테스트들이 이미
  // 기본 동작을 고정한다. 여기서는 옵션 자체의 두 갈래(기본 유지 / opt-in 동작)만 명시적으로 본다.
  it('옵션 없이 생성하면 기존 내용부터 읽는다 (기본 동작 회귀 없음 — codex 쪽 동작 유지)', async () => {
    const p = path.join(dir, 'f.jsonl')
    await writeFile(p, '{"a":1}\n{"b":2}\n') // 생성 전에 이미 있던 내용
    const tail = new JsonlTail(p)
    expect((await tail.read())?.lines).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('startAtEnd:true면 생성 시점 이전 내용은 절대 읽지 않는다', async () => {
    const p = path.join(dir, 'g.jsonl')
    await writeFile(p, '{"old":1}\n{"old":2}\n') // 이미 있던 내용
    const tail = new JsonlTail(p, { startAtEnd: true })
    const first = await tail.read()
    expect(first?.lines).toEqual([]) // 기존 내용을 건너뛴다
    expect(first?.restarted).toBe(false)
    await appendFile(p, '{"new":1}\n') // 그 뒤에 덧붙은 내용만
    expect((await tail.read())?.lines).toEqual(['{"new":1}'])
  })
})
