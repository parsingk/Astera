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

  // 값이 아니라 모드다 — args 에 둘어가면 앱에게 보내는 인자가 된다
  it('--quiet 은 모드지 인자가 아니다', () => {
    const r = parseArgs(['jobs', 'list', '--quiet'])
    expect(r).toMatchObject({ cmd: 'jobs-list', quiet: true })
    expect((r as { args: Record<string, unknown> }).args.quiet).toBeUndefined()
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

describe('반복되는 플래그', () => {
  it('--check 는 여러 번 와서 배열이 된다', () => {
    const r = parseArgs(['session-task-complete', '--check', 'tests=passed', '--check', 'build=skipped'])
    expect(r).toMatchObject({ args: { check: ['tests=passed', 'build=skipped'] } })
  })

  it('한 번만 와도 배열이다 — 부르는 쪽이 두 모양을 다루지 않게', () => {
    const r = parseArgs(['session-task-complete', '--check', 'tests=passed'])
    expect(r).toMatchObject({ args: { check: ['tests=passed'] } })
  })

  it('반복 목록에 없는 플래그는 마지막 값이 이긴다 — 지금 동작 그대로다', () => {
    const r = parseArgs(['send', '--text', 'a', '--text', 'b'])
    expect(r).toMatchObject({ args: { text: 'b' } })
  })
  it('browser js is one command, browser-js, and reads its script from stdin by default', () => {
    const r = parseArgs(['browser', 'js'])
    expect(r).toMatchObject({ cmd: 'browser-js', wantsStdin: ['script'] })
  })
  it('browser js --script - asks for stdin once, not twice', () => {
    const r = parseArgs(['browser', 'js', '--script', '-'])
    expect(r).toMatchObject({ cmd: 'browser-js', wantsStdin: ['script'] })
  })
  it('browser js --file reads no stdin', () => {
    const r = parseArgs(['browser', 'js', '--file', 'check.js']) as { cmd: string; args: Record<string, unknown>; wantsStdin: string[] }
    expect(r.cmd).toBe('browser-js')
    expect(r.args.file).toBe('check.js')
    expect(r.wantsStdin).toEqual([])
  })
  it('browser js --file and --script together is an error', () => {
    expect(parseArgs(['browser', 'js', '--file', 'check.js', '--script', '-'])).toEqual({
      error: 'browser js takes one script: --file or --script, not both'
    })
  })
  it('browser help is browser-help', () => {
    expect(parseArgs(['browser', 'help'])).toMatchObject({ cmd: 'browser-help', wantsStdin: [] })
  })
  it('browser alone names its subcommands', () => {
    expect(parseArgs(['browser'])).toEqual({ error: 'browser needs a subcommand: js or help' })
  })
  it('browser with an unknown subcommand is refused', () => {
    expect(parseArgs(['browser', 'fly'])).toEqual({ error: 'unknown browser subcommand: fly (expected js or help)' })
  })
})

describe('공개 표면 — 두 낱말 명령', () => {
  it('명사와 동사를 한 토큰으로 잇는다', () => {
    expect(parseArgs(['jobs', 'list'])).toMatchObject({ cmd: 'jobs-list' })
    expect(parseArgs(['jobs', 'get', '--id', 'job_1'])).toMatchObject({
      cmd: 'jobs-get',
      args: { id: 'job_1' }
    })
  })

  it('읽기 표면의 다섯 명사를 전부 잇는다', () => {
    expect(parseArgs(['projects', 'list'])).toMatchObject({ cmd: 'projects-list' })
    expect(parseArgs(['projects', 'find', '--path', 'D:/p'])).toMatchObject({
      cmd: 'projects-find',
      args: { path: 'D:/p' }
    })
    expect(parseArgs(['runs', 'list', '--job', 'job_1'])).toMatchObject({
      cmd: 'runs-list',
      args: { job: 'job_1' }
    })
    expect(parseArgs(['runs', 'get', '--id', 'run_1'])).toMatchObject({ cmd: 'runs-get' })
    expect(parseArgs(['questions', 'get', '--id', 'gate_1'])).toMatchObject({
      cmd: 'questions-get'
    })
    expect(parseArgs(['jobs', 'wait', '--id', 'job_1'])).toMatchObject({ cmd: 'jobs-wait' })
    expect(parseArgs(['jobs', 'run', '--id', 'job_1'])).toMatchObject({ cmd: 'jobs-run' })
    expect(parseArgs(['runs', 'wait', '--id', 'run_1'])).toMatchObject({ cmd: 'runs-wait' })
    expect(parseArgs(['questions', 'answer', '--id', 'g', '--answer', 'A'])).toMatchObject({
      cmd: 'questions-answer',
      args: { id: 'g', answer: 'A' }
    })
  })

  it('동사가 없으면 무엇을 칠 수 있는지 말한다', () => {
    expect(parseArgs(['projects'])).toEqual({ error: 'projects needs one of: list, get, find' })
    expect(parseArgs(['jobs'])).toEqual({ error: 'jobs needs one of: list, get, wait, run' })
  })

  it('모르는 동사는 거절하고 목록을 보여 준다', () => {
    expect(parseArgs(['jobs', 'fly'])).toEqual({
      error: 'unknown jobs subcommand: fly (expected list, get, wait, run)'
    })
  })

  // 플래그가 동사 자리에 오면 동사를 안 준 것이다 — `--json` 을 동사로 읽으면 엉뚱한 오류가 난다
  it('플래그를 동사로 읽지 않는다', () => {
    expect(parseArgs(['tasks', '--json'])).toEqual({
      error: 'tasks needs one of: list'
    })
  })

  // 코디네이터 전용 명령은 한 낱말 그대로다 — 개명이 가이드 재작성만 사고 아무것도 주지 않는다
  it('한 낱말 명령은 그대로 지나간다', () => {
    expect(parseArgs(['worker-start', '--task', 'tsk_1'])).toMatchObject({ cmd: 'worker-start' })
    expect(parseArgs(['task-create', '--spec', 's'])).toMatchObject({ cmd: 'task-create' })
  })
})

describe('없어진 이름', () => {
  // **별칭이 아니다 — 명령은 돌지 않는다.** 대신 무엇을 치면 되는지 말한다. 옛 이름을 쓰던 것은
  // 매번 astera help 를 읽고 시작하는 에이전트이고, 그쪽은 이 한 줄로 스스로 고친다.
  it('대신 칠 이름을 말한다', () => {
    expect(parseArgs(['run-list'])).toEqual({
      error: 'run-list was renamed to `jobs list` (astera help)'
    })
    expect(parseArgs(['gate-list', '--status', 'open'])).toEqual({
      error: 'gate-list was renamed to `questions list` (astera help)'
    })
  })

  it('옛 이름은 실행되지 않는다 — 인자를 붙여도 같다', () => {
    const r = parseArgs(['run-show', '--id', 'run_1'])
    expect('error' in r).toBe(true)
  })

  // 아직 공개 동사가 없는 명령은 표에 없다 — 안내가 404 를 가리키면 오타와 구별되지 않는다
  it('공개 이름이 아직 없는 명령은 그대로 돈다', () => {
    expect(parseArgs(['run-start', '--run', 'run_1'])).toMatchObject({ cmd: 'run-start' })
    expect(parseArgs(['gate-resolve', '--id', 'g1'])).toMatchObject({ cmd: 'gate-resolve' })
  })
})
