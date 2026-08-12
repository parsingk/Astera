import { describe, it, expect } from 'vitest'
import { camel, parseArgs } from './cliArgs'

describe('camel', () => {
  it('kebab-case를 camelCase로 바꾼다', () => {
    expect(camel('task-id')).toBe('taskId')
    expect(camel('dispatch-id')).toBe('dispatchId')
    expect(camel('files-modified')).toBe('filesModified')
    expect(camel('timeout-ms')).toBe('timeoutMs')
    expect(camel('retry-of')).toBe('retryOf')
  })
  it('단어 하나는 그대로 둔다', () => {
    expect(camel('json')).toBe('json')
  })
})

describe('parseArgs', () => {
  it('명령과 문자열 플래그를 읽는다', () => {
    const r = parseArgs(['run-create', '--objective', '인증 리팩터', '--json'])
    expect(r).toMatchObject({ cmd: 'run-create', json: true })
    expect((r as { args: Record<string, unknown> }).args.objective).toBe('인증 리팩터')
  })
  it('값이 없는 플래그는 true다', () => {
    const r = parseArgs(['check', '--wait', '--json']) as { args: Record<string, unknown> }
    expect(r.args.wait).toBe(true)
  })
  it('--timeout-ms를 숫자로 바꾼다', () => {
    const r = parseArgs(['ask', '--timeout-ms', '600000']) as { args: Record<string, unknown> }
    expect(r.args.timeoutMs).toBe(600000)
  })
  it('--limit도 숫자로 바꾼다', () => {
    const r = parseArgs(['inbox', '--limit', '10']) as { args: Record<string, unknown> }
    expect(r.args.limit).toBe(10)
  })
  it('값이 - 인 플래그는 stdin 대상으로 표시한다', () => {
    const r = parseArgs(['task-create', '--spec', '-']) as { wantsStdin: string[] }
    expect(r.wantsStdin).toEqual(['spec'])
  })
  it('--deps는 JSON 배열로 파싱한다', () => {
    const r = parseArgs(['task-create', '--deps', '["tsk_1","tsk_2"]']) as {
      args: Record<string, unknown>
    }
    expect(r.args.deps).toEqual(['tsk_1', 'tsk_2'])
  })
  it('--options는 gate-create에서 JSON 배열, ask에서 CSV다', () => {
    const gate = parseArgs(['gate-create', '--options', '["yes","no"]']) as {
      args: Record<string, unknown>
    }
    expect(gate.args.options).toEqual(['yes', 'no'])
    const ask = parseArgs(['ask', '--options', 'a,b']) as { args: Record<string, unknown> }
    expect(ask.args.options).toBe('a,b')
  })
  it('명령이 없으면 에러다', () => {
    expect(parseArgs([])).toMatchObject({ error: expect.stringContaining('command') })
  })
  it('플래그로 시작하면 에러다', () => {
    expect(parseArgs(['--json'])).toMatchObject({ error: expect.any(String) })
  })
  it('깨진 --deps JSON은 에러다', () => {
    expect(parseArgs(['task-create', '--deps', '[broken'])).toMatchObject({
      error: expect.stringContaining('deps')
    })
  })
  it('--limit이 빈 문자열이면 에러다', () => {
    expect(parseArgs(['inbox', '--limit', ''])).toMatchObject({
      error: expect.stringContaining('limit')
    })
  })
  it('--limit이 공백만 있으면 에러다', () => {
    expect(parseArgs(['inbox', '--limit', '   '])).toMatchObject({
      error: expect.stringContaining('limit')
    })
  })
  it('--timeout-ms가 빈 문자열이면 에러다', () => {
    expect(parseArgs(['ask', '--timeout-ms', ''])).toMatchObject({
      error: expect.stringContaining('timeout-ms')
    })
  })
})
