import { describe, it, expect } from 'vitest'
import {
  codeForStatus,
  dataFor,
  errEnvelope,
  exitCodeFor,
  messageFrom,
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

  it('실패는 ok 와 code·message·details 다', () => {
    expect(JSON.parse(errEnvelope({ code: 'NOT_FOUND', message: 'unknown job: job_x' }))).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'unknown job: job_x', details: {} }
    })
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
