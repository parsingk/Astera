import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readNewLines } from './tail'

let dir: string
let file: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-tail-'))
  file = path.join(dir, 't.jsonl')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('readNewLines', () => {
  it('커서가 없으면 처음부터 읽는다', async () => {
    await fs.writeFile(file, 'a\nb\n', 'utf8')
    const r = await readNewLines(file, null)
    expect(r.lines).toEqual(['a', 'b'])
    expect(r.restarted).toBe(true)
  })

  it('커서가 있으면 그 뒤만 읽는다 — 이것이 이 파일의 존재 이유다', async () => {
    await fs.writeFile(file, 'a\nb\n', 'utf8')
    const first = await readNewLines(file, null)

    await fs.appendFile(file, 'c\n', 'utf8')
    const second = await readNewLines(file, first)

    expect(second.lines).toEqual(['c'])
    expect(second.restarted).toBe(false)
  })

  it('덧붙은 것이 없으면 빈 결과다', async () => {
    await fs.writeFile(file, 'a\n', 'utf8')
    const first = await readNewLines(file, null)
    const second = await readNewLines(file, first)
    expect(second.lines).toEqual([])
    expect(second.offset).toBe(first.offset)
  })

  // 트랜스크립트는 한 줄이 통째로 쓰이지 않을 수 있다. 반쪽 줄을 JSON.parse 에 넘기면 그 줄이
  // 영영 사라진다 — 다음 읽기는 그 뒤부터 시작하기 때문이다.
  it('마지막 줄이 개행으로 끝나지 않으면 그 줄은 남겨 둔다', async () => {
    await fs.writeFile(file, 'a\nb\nhalf', 'utf8')
    const r = await readNewLines(file, null)
    expect(r.lines).toEqual(['a', 'b'])
    expect(r.offset).toBe(Buffer.byteLength('a\nb\n'))
  })

  it('다음 읽기에서 그 반쪽 줄이 완성되면 온전히 나온다', async () => {
    await fs.writeFile(file, 'a\nhal', 'utf8')
    const first = await readNewLines(file, null)
    expect(first.lines).toEqual(['a'])

    await fs.appendFile(file, 'f\n', 'utf8')
    const second = await readNewLines(file, first)
    expect(second.lines).toEqual(['half'])
  })

  it('파일이 작아졌으면 처음부터 다시 읽는다 — 다른 파일이거나 잘린 것이다', async () => {
    await fs.writeFile(file, 'a\nb\nc\n', 'utf8')
    const first = await readNewLines(file, null)

    await fs.writeFile(file, 'x\n', 'utf8')
    const second = await readNewLines(file, first)

    expect(second.lines).toEqual(['x'])
    expect(second.restarted).toBe(true)
  })

  it('파일이 없으면 빈 결과이고 던지지 않는다', async () => {
    const r = await readNewLines(path.join(dir, 'nope.jsonl'), null)
    expect(r.lines).toEqual([])
    expect(r.offset).toBe(0)
  })

  it('여러 바이트 문자가 경계에서 깨지지 않는다', async () => {
    await fs.writeFile(file, '한글\n', 'utf8')
    const first = await readNewLines(file, null)
    expect(first.lines).toEqual(['한글'])

    await fs.appendFile(file, '두번째\n', 'utf8')
    const second = await readNewLines(file, first)
    expect(second.lines).toEqual(['두번째'])
  })
})
