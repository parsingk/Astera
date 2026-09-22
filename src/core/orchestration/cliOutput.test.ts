import { describe, it, expect } from 'vitest'
import {
  CLI_ERROR_CODES,
  codeForStatus,
  dataFor,
  errEnvelope,
  exitCodeFor,
  messageFrom,
  nextStepsFor,
  okEnvelope,
  waitEnd
} from './cliOutput'

describe('exitCodeFor', () => {
  // 설계 §8 의 표를 그대로 고정한다. 이 숫자들은 스크립트가 분기하는 값이라, 바뀌면 남의 CI 가
  // 조용히 틀린 길로 간다 — 표를 옮겨 적은 것이 아니라 계약을 박아 두는 테스트다.
  it('코드마다 정해진 종료 코드를 준다', () => {
    expect(exitCodeFor('FAILED')).toBe(1)
    expect(exitCodeFor('INVALID_ARGUMENTS')).toBe(2)
    expect(exitCodeFor('HOST_NOT_RUNNING')).toBe(3)
    expect(exitCodeFor('NOT_FOUND')).toBe(4)
    expect(exitCodeFor('PERMISSION_DENIED')).toBe(5)
    expect(exitCodeFor('CONFLICT')).toBe(6)
    expect(exitCodeFor('TIMEOUT')).toBe(7)
    expect(exitCodeFor('WAITING_FOR_INPUT')).toBe(8)
    expect(exitCodeFor('VERSION_MISMATCH')).toBe(9)
    expect(exitCodeFor('RUN_FAILED')).toBe(10)
  })
})

describe('codeForStatus', () => {
  it('서버가 이미 가려 답하는 것을 옮긴다', () => {
    expect(codeForStatus(400)).toBe('INVALID_ARGUMENTS')
    expect(codeForStatus(403)).toBe('PERMISSION_DENIED')
    expect(codeForStatus(404)).toBe('NOT_FOUND')
    expect(codeForStatus(409)).toBe('CONFLICT')
  })

  // 없는 id(404) 와 없는 명령(501) 은 스크립트에게 다른 사건이다 — 뒤의 것은 앱과
  // CLI 의 버전이 갈렸다는 뜻이고, 고칠 사람도 고칠 곳도 다르다.
  it('모르는 명령의 501 은 버전 불일치다', () => {
    expect(codeForStatus(501)).toBe('VERSION_MISMATCH')
    expect(exitCodeFor(codeForStatus(501))).toBe(9)
  })

  // 짐작이 스크립트의 분기를 조용히 틀리게 만든다
  it('모르는 상태는 일반 실패다 — 그럴듯한 코드로 넘겨짚지 않는다', () => {
    expect(codeForStatus(500)).toBe('FAILED')
    expect(codeForStatus(418)).toBe('FAILED')
    expect(codeForStatus(0)).toBe('FAILED')
  })
})

describe('dataFor', () => {
  // **최상위 배열은 칸 하나를 더할 수 없다.** 그것이 이 함수가 있는 이유다(설계 §7).
  it('목록을 그 명령의 이름 있는 칸에 담는다', () => {
    expect(dataFor('jobs-list', [{ id: 'job_1' }])).toEqual({ jobs: [{ id: 'job_1' }] })
    expect(dataFor('projects-list', [])).toEqual({ projects: [] })
    expect(dataFor('questions-list', [])).toEqual({ questions: [] })
  })

  // 공개 표면은 아니지만 코디네이터가 읽는다 — 세을 items 한 이름으로 묶으면 가이드가 그
  // 자리마다 "어떤 items 인가" 를 다시 설명해야 한다
  it('코디네이터가 읽는 목록도 제 이름을 가진다', () => {
    expect(dataFor('dispatch-show', [{ id: 'dsp_1' }])).toEqual({ dispatches: [{ id: 'dsp_1' }] })
    expect(dataFor('inbox', [])).toEqual({ messages: [] })
    expect(dataFor('run-configs', [])).toEqual({ configs: [] })
  })

  // 그 밖의 것은 한 이름으로 떨어진다
  it('표에 없는 명령의 배열은 items 다', () => {
    expect(dataFor('worker-read', ['a'])).toEqual({ items: ['a'] })
  })

  it('객체는 그대로 지나간다', () => {
    expect(dataFor('jobs-get', { id: 'job_1', objective: 'o' })).toEqual({
      id: 'job_1',
      objective: 'o'
    })
  })

  // 입력은 명령이 아니라 앱의 응답이다 — 이 갈래를 만드는 명령은 없지만 값으로 받는다
  it('객체가 아닌 값도 칸에 담는다', () => {
    expect(dataFor('x', 'hello')).toEqual({ value: 'hello' })
    expect(dataFor('x', null)).toEqual({ value: null })
  })
})

describe('봉투', () => {
  it('성공은 ok 와 data 다', () => {
    expect(JSON.parse(okEnvelope('jobs-list', [{ id: 'job_1' }]))).toEqual({
      ok: true,
      data: { jobs: [{ id: 'job_1' }] }
    })
  })

  it('실패는 ok 와 code·message·details·nextSteps 다', () => {
    expect(JSON.parse(errEnvelope({ code: 'NOT_FOUND', message: 'unknown job: job_x' }, 'jobs-get'))).toEqual({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: 'unknown job: job_x',
        details: {},
        nextSteps: ['astera jobs list']
      }
    })
  })

  // `details` 가 `{}` 로 언제나 있는 것과 같은 판단이다 — 읽는 쪽이 `error.nextSteps[0]` 앞에
  // 칸의 유무를 먼저 묻지 않아도 된다.
  it('칠 것이 없어도 칸은 있다', () => {
    expect(JSON.parse(errEnvelope({ code: 'FAILED', message: 'x' })).error.nextSteps).toEqual([])
  })

  // 한 줄이어야 한다 — 스크립트가 줄 단위로 읽는다
  it('줄바꿈 없이 한 줄이다', () => {
    expect(okEnvelope('jobs-list', [])).not.toContain('\n')
    expect(errEnvelope({ code: 'FAILED', message: 'x' })).not.toContain('\n')
  })
})

describe('messageFrom', () => {
  it('앱의 {error} 에서 문구를 꺼낸다', () => {
    expect(messageFrom({ error: 'nope' }, 'fallback')).toBe('nope')
  })

  // 앱이 주는 것을 그대로 믿지 않는다 — 읽을 수 없으면 부르는 쪽의 문구가 남는다
  it('읽을 수 없으면 대체 문구다', () => {
    expect(messageFrom({}, 'fallback')).toBe('fallback')
    expect(messageFrom(null, 'fallback')).toBe('fallback')
    expect(messageFrom({ error: 42 }, 'fallback')).toBe('fallback')
  })
})

describe('waitEnd', () => {
  // 물어본 것이 "잘 끝날 때까지 기다려라" 이므로, 실패로 끝난 회차를 ok:true 로 내면
  // 스크립트가 그것을 성공으로 읽는다
  it('잘 끝난 것만 성공이다', () => {
    expect(waitEnd({ state: 'completed', runId: 'run_1' })).toBe(null)
    expect(waitEnd({ state: 'failed', runId: 'run_1' })?.code).toBe('RUN_FAILED')
  })

  // 사람이 손대기 전에는 움직이지 않는다 — 질문도 일시정지도 같은 종류의 끝이다
  it('사람을 기다리는 두 끝은 같은 코드이고 본문이 가른다', () => {
    const q = waitEnd({ state: 'waiting', questionId: 'gat_1', taskId: 'tsk_1', runId: 'run_1' })
    expect(q?.code).toBe('WAITING_FOR_INPUT')
    expect(q?.details?.questionId).toBe('gat_1')
    const p = waitEnd({ state: 'paused', runId: 'run_1' })
    expect(p?.code).toBe('WAITING_FOR_INPUT')
    expect(p?.details?.state).toBe('paused')
  })

  it('마감은 TIMEOUT 이고, 어디까지 왔는지를 싣는다', () => {
    const t = waitEnd({ state: 'timeout', runId: 'run_1', progress: { done: 2, total: 7 } })
    expect(t?.code).toBe('TIMEOUT')
    expect(t?.details?.progress).toEqual({ done: 2, total: 7 })
  })

  // 짐작해서 0 으로 내보내면 스크립트가 안 끝난 일을 끝난 것으로 읽는다
  it('모르는 끝은 성공으로 넘기지 않는다', () => {
    expect(waitEnd({ state: 'something-new' })?.code).toBe('FAILED')
    expect(waitEnd({})?.code).toBe('FAILED')
    expect(waitEnd(null)?.code).toBe('FAILED')
  })
})

describe('nextStepsFor — 무엇을 치면 되는가', () => {
  // 이 두 코드가 가장 자주 나고, 둘 다 답이 정확히 하나 있다
  it('Host 가 없으면 Host 를 켜는 명령이다', () => {
    expect(nextStepsFor({ code: 'HOST_NOT_RUNNING' })).toEqual(['astera host start'])
  })

  it('없는 id 는 그 명령의 목록 명령으로 이어진다', () => {
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'jobs-get' })).toEqual(['astera jobs list'])
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'runs-stop' })).toEqual(['astera runs list'])
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'questions-answer' })).toEqual(['astera questions list'])
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'projects-get' })).toEqual(['astera projects list'])
  })

  // 세션 전용 명령은 무엇을 못 찾았다고 말하는지가 갈래다 — worker-start 가 못 찾는 것은
  // Dispatch 가 아니라 Task 이고, run-create 가 못 찾는 것은 회차가 아니라 계정이다.
  it('세션 전용 명령은 그것이 못 찾은 것의 목록으로 이어진다', () => {
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'worker-start' })).toEqual(['astera tasks list'])
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'worker-show' })).toEqual([
      'astera dispatch-show --task <taskId>'
    ])
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'run-create' })).toEqual(['astera accounts'])
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'run-merge' })).toEqual(['astera runs list'])
  })

  // 모르는 명령에 그럴듯한 목록 명령을 지어내지 않는다
  it('짚을 곳이 없으면 가이드다', () => {
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'nonesuch' })).toEqual(['astera help'])
    expect(nextStepsFor({ code: 'NOT_FOUND' })).toEqual(['astera help'])
  })

  it('인자가 틀린 것은 그 명령의 사용법으로 이어진다', () => {
    expect(nextStepsFor({ code: 'INVALID_ARGUMENTS', cmd: 'jobs-wait' })).toEqual([
      'astera jobs wait --help'
    ])
    // 한 낱말짜리 명령은 대시를 쪼개지 않는다 — `astera agent context --help` 는 없는 명령이다
    expect(nextStepsFor({ code: 'INVALID_ARGUMENTS', cmd: 'agent-context' })).toEqual([
      'astera agent-context --help'
    ])
    // 공개 표면 밖의 명령에는 `--help` 가 없다
    expect(nextStepsFor({ code: 'INVALID_ARGUMENTS', cmd: 'worker-start' })).toEqual(['astera help'])
    expect(nextStepsFor({ code: 'INVALID_ARGUMENTS' })).toEqual(['astera --help'])
  })

  // 원인이 무엇인지 이쪽은 모른다 — 아무 명령이나 얹으면 맞는 경우보다 틀린 경우가 많다
  it('FAILED 는 비어 있고, 그것이 판단이다', () => {
    expect(nextStepsFor({ code: 'FAILED' })).toEqual([])
    expect(nextStepsFor({ code: 'FAILED', cmd: 'jobs-get' })).toEqual([])
  })

  it('열 코드 전부가 답을 가진다 — 비어 있는 것도 답이다', () => {
    for (const code of CLI_ERROR_CODES) expect(nextStepsFor({ code }), code).toBeInstanceOf(Array)
  })

  // 자리표시자를 채워 주면 그대로 칠 수 있는 줄이 된다 — wait 의 오류는 이미 그 값을 싣고 있다
  it('details 에 있는 id 는 자리표시자에 채워진다', () => {
    const end = waitEnd({ state: 'failed', runId: 'run_9' })!
    expect(nextStepsFor({ code: end.code, cmd: 'runs-wait', details: end.details })).toEqual([
      'astera tasks list --run run_9 --status failed'
    ])
  })

  // 짐작한 id 를 채우는 것보다 비워 두는 편이 낫다
  it('없는 값은 자리표시자로 남는다', () => {
    expect(nextStepsFor({ code: 'RUN_FAILED' })).toEqual([
      'astera tasks list --run <runId> --status failed'
    ])
  })

  it('409 는 지금 무엇이 도는가로, 그리고 host 명령은 Host 쪽으로 이어진다', () => {
    expect(nextStepsFor({ code: 'CONFLICT', cmd: 'jobs-run' })).toEqual(['astera status'])
    expect(nextStepsFor({ code: 'CONFLICT', cmd: 'host-stop' })).toEqual(['astera host status'])
  })
})
