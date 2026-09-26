import { describe, it, expect } from 'vitest'
import {
  CLI_ERROR_CODES,
  askTimeoutBody,
  codeForStatus,
  dataFor,
  errEnvelope,
  exitCodeFor,
  messageFrom,
  nextStepsFor,
  okEnvelope,
  silentHostEnd,
  sessionTurnEnd,
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
    expect(dataFor('run-configs-list', [])).toEqual({ runConfigs: [] })
    expect(dataFor('sessions-list', [])).toEqual({ sessions: [] })
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

  it('a usage-reset wait is 8, and says when it resumes (Q3)', () => {
    const l = waitEnd({ state: 'limited', runId: 'run_1', resetsAt: '2026-09-25T15:00:00.000Z', progress: { done: 0, total: 1 } })
    expect(l?.code).toBe('WAITING_FOR_INPUT')
    expect(l?.message).toMatch(/2026-09-25T15:00:00\.000Z/)
    expect(l?.details).toMatchObject({ state: 'limited', resetsAt: '2026-09-25T15:00:00.000Z' })
    expect(exitCodeFor('WAITING_FOR_INPUT')).toBe(8)
    expect(nextStepsFor({ code: 'WAITING_FOR_INPUT', cmd: 'runs-wait', details: { state: 'limited' } })).toEqual([
      'astera runs wait --id <runId>',
      'astera runs get --id <runId>'
    ])
  })
})

describe('nextStepsFor — 무엇을 치면 되는가', () => {
  // 이 두 코드가 가장 자주 나고, 둘 다 답이 정확히 하나 있다
  it('Host 가 없으면 Host 를 켜는 명령이다', () => {
    expect(nextStepsFor({ code: 'HOST_NOT_RUNNING' })).toEqual(['astera host start'])
  })

  // 감사 #12. 다른 판의 Host 가 이 프로필을 쥐고 있을 때 `host stop` 은 이 CLI 로는 닿지 않는다.
  // `host start` 도 권하지 않는다: 그 Host 가 있는 동안에는 9 로 거절되는 돌고 도는 안내다. 칠 것은
  // docs/cli.md 의 Exit 9 절이 말하는 하나, `astera version` 뿐이고, 무엇을 할지는 문구가 말한다.
  it('다른 판의 Host 를 찾은 9 는 어느 명령에서든 astera version 하나다', () => {
    for (const cmd of [undefined, 'jobs-list', 'status', 'host-status', 'host-start'])
      expect(nextStepsFor({ code: 'VERSION_MISMATCH', cmd, details: { hostProtocol: 4 } })).toEqual(['astera version'])
    expect(nextStepsFor({ code: 'VERSION_MISMATCH' })).toEqual(['astera version', 'astera host stop'])
  })

  // 리뷰 I1. 실패한 명령이 `host start` 자신이면 그것을 다시 권하는 것은 돌고 도는 안내다.
  it('host start 의 실패는 host start 를 권하지 않는다', () => {
    expect(nextStepsFor({ code: 'VERSION_MISMATCH', cmd: 'host-start', details: { hostProtocol: 4 } })).toEqual([
      'astera version'
    ])
    expect(nextStepsFor({ code: 'HOST_NOT_RUNNING', cmd: 'host-start' })).toEqual(['astera host status'])
    expect(nextStepsFor({ code: 'HOST_NOT_RUNNING', cmd: 'host-status' })).toEqual(['astera host start'])
  })

  it('없는 id 는 그 명령의 목록 명령으로 이어진다', () => {
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'jobs-get' })).toEqual(['astera jobs list'])
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'runs-stop' })).toEqual(['astera runs list'])
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'questions-answer' })).toEqual(['astera questions list'])
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'projects-get' })).toEqual(['astera projects list'])
  })

  // **이름의 목록이 틀린 종류일 때는 표가 이긴다.** tasks list 가 못 찾는 것은 `--run` 의 회차다 —
  // `tasks list` 를 다시 권하면 Task id 가 나온다.
  it('tasks list 의 404 는 회차 목록으로 간다', () => {
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'tasks-list' })).toEqual(['astera runs list'])
  })

  // 같은 모양의 반대쪽: runs list 가 못 찾는 것은 `--job` 의 Job 이다. `runs list` 를 다시 권하면
  // 회차 id 가 나오고, 그것을 --job 에 주면 다시 404 다.
  it('runs list 의 404 는 Job 목록으로 간다', () => {
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'runs-list' })).toEqual(['astera jobs list'])
  })

  // The list filters of CLI spec §16 and §19. `jobs list` fails only on `--project`'s folder, and
  // `questions list` only on `--run`'s run; the noun rule would offer the same list again.
  it('jobs list 의 404 는 프로젝트 목록으로, questions list 의 404 는 회차 목록으로 간다', () => {
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'jobs-list' })).toEqual(['astera projects list'])
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'questions-list' })).toEqual(['astera runs list'])
  })

  // 세션 전용 명령은 무엇을 못 찾았다고 말하는지가 갈래다 — run-create 가 못 찾는 것은
  // 회차가 아니라 계정이다.
  it('세션 전용 명령은 그것이 못 찾은 것의 목록으로 이어진다', () => {
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'run-create' })).toEqual(['astera accounts list'])
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'run-merge' })).toEqual(['astera runs list'])
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'task-update' })).toEqual(['astera tasks list'])
  })

  // **404 를 내지 않는 명령에 404 안내를 달아 두지 않는다.** worker-read·worker-release 는 존재
  // 검사 자체가 없다.
  it('404 를 낼 수 없는 명령에는 404 항목이 없다', () => {
    for (const cmd of ['worker-read', 'worker-release'])
      expect(nextStepsFor({ code: 'NOT_FOUND', cmd }), cmd).toEqual(['astera help'])
  })

  // **이 셋은 이제 404 를 낸다** — 순수 층의 거절을 400 으로 내보내던 자리가 없는 id 를 404 로
  // 말하게 되었다. 각 줄은 못 찾은 것과 같은 종류의 id 를 내놓고, 그 명령을 부른 쪽이 칠 수 있다.
  it('check·send·gate-resolve 의 404 는 못 찾은 것의 목록으로 간다', () => {
    // 두 가지를 못 찾는다: `--run` 의 회차(runId 없이 온다 — 회차 목록), 그리고 `--ack` 의 배치(그
    // 404 는 확인한 회차의 runId 를 싣는다 — 그 회차의 check 가 열린 배치의 deliveryId 를 다시 준다)
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'check' })).toEqual(['astera runs list'])
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'check', details: { runId: 'run_1' } })).toEqual([
      'astera check --run run_1'
    ])
    // worker_done 의 Task 나 Dispatch — worker-* 와 같은 두 줄, 둘 다 워커가 부를 수 있다
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'send' })).toEqual([
      'astera tasks list',
      'astera dispatch-show --task <taskId>'
    ])
    // Gate 다 — questions list 가 세는 것이 s.gates 이고 resolveGate 가 찾는 곳도 거기다
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'gate-resolve' })).toEqual(['astera questions list'])
  })

  // **`--run` 에 Job id 는 통한다 — 그래서 더 나쁘다.** 회차가 아니라 템플릿에 정의 Task 가 생기고
  // 0 으로 끝난다. 실패하는 줄보다 조용히 다른 것을 만드는 줄이 나쁘다.
  // `--account` 의 없는 계정도 404 다(6b403c7). 그 id 는 두 목록 어디에도 없다.
  it('task-create 는 회차 목록으로 간다, Job 목록이 아니라', () => {
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'task-create' })).toEqual([
      'astera runs list',
      'astera tasks list',
      'astera accounts list'
    ])
  })

  // phase C. 표가 명사 규칙을 이긴다 — jobs create 가 못 찾는 것은 계획이 아니라 계정이다.
  // tasks add 는 네 가지를 못 찾는다: --job 의 계획, --run 의 회차, --deps·--parent 의 Task,
  // --account 의 계정. 종류를 확인하므로 다른 목록의 id 는 받아들여지지 않고 404 다.
  it('jobs create 와 tasks add 는 못 찾은 것의 목록으로 간다', () => {
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'jobs-create' })).toEqual(['astera accounts list'])
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'tasks-add' })).toEqual([
      'astera jobs list',
      'astera runs list',
      'astera tasks list',
      'astera accounts list'
    ])
  })

  // phase D. `--validate` 의 구성 id 를 못 찾은 404 만 계획 id 를 싣고 온다 — 그때는 그 계획의 구성
  // 목록 한 줄이고, 계획 id 가 채워져 그대로 칠 수 있다. 나머지 tasks add 404 는 위의 네 줄 그대로다.
  it('tasks add 의 없는 구성 id 는 그 계획의 run-configs list 로 간다', () => {
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'tasks-add', details: { jobId: 'job_1' } })).toEqual([
      'astera run-configs list --job job_1'
    ])
    // run-configs list 가 못 찾는 것은 계획이다. 명사 규칙(`run` 이나 `run-configs`)이 아니다.
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'run-configs-list' })).toEqual(['astera jobs list'])
    expect(nextStepsFor({ code: 'INVALID_ARGUMENTS', cmd: 'run-configs-list' })).toEqual([
      'astera run-configs list --help'
    ])
  })

  // skills 가 못 찾는 것은 --account 의 계정뿐이다. 명사 규칙은 `skills list` 를 줄 텐데 그것은
  // 같은 --account 로 같은 404 다.
  it('skills 의 404 는 계정 목록으로 간다', () => {
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'skills-list' })).toEqual(['astera accounts list'])
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'skills-install' })).toEqual(['astera accounts list'])
  })

  // 명사 규칙 그대로다 — 못 찾는 것은 `--id` 의 세션 하나이고, 그 id 는 `sessions list` 가 준다.
  it('sessions read·send 의 404 는 세션 목록으로 간다', () => {
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'sessions-read' })).toEqual(['astera sessions list'])
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'sessions-send' })).toEqual(['astera sessions list'])
  })

  // **`--id` 가 Job 도 회차도 받고 지우는 것이 다르다.** Job 목록만 주면 회차 하나를 지우려던
  // 사람에게 계획째 지우는 id 를 건네는 셈이다.
  it('run-delete 는 두 목록을 다 준다', () => {
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'run-delete' })).toEqual([
      'astera jobs list',
      'astera runs list'
    ])
  })

  // Dispatch 를 통째로 세는 명령이 없으므로, 앞 줄이 뒷줄의 <taskId> 를 준다. worker-start 의
  // 두 번째 404 는 `--terminal` 의 sessionId 이고, 그것을 내놓는 것도 Dispatch 쪽이다.
  it('찾을 값이 한 명령 앞에 있으면 두 줄로 준다', () => {
    for (const cmd of ['worker-show', 'worker-start'])
      expect(nextStepsFor({ code: 'NOT_FOUND', cmd }), cmd).toEqual([
        'astera tasks list',
        'astera dispatch-show --task <taskId>'
      ])
  })

  // **부르는 쪽이 부를 수 있어야 한다.** ask 는 워커도 부르는데 inbox 는 코디네이터 전용이라,
  // 워커가 그 줄을 따르면 403 으로 5 를 받는다. 메시지를 세는 명령을 워커는 못 부르므로, 워커가
  // 실제로 할 수 있는 일은 다시 묻는 것이다. reply 는 자신이 코디네이터 전용이라 inbox 가 맞다.
  it('워커가 만나는 404 는 워커가 칠 수 있는 줄로 간다', () => {
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'ask' })).toEqual([
      'astera ask --task-id <taskId> --question <text>'
    ])
    expect(nextStepsFor({ code: 'NOT_FOUND', cmd: 'reply' })).toEqual(['astera inbox'])
  })

  /**
   * **답이 아예 안 온 실패에서는 "닿았는가" 가 먼저다**(요청 영수증 설계 §8). 그 끝만 이 값을
   * 싣는다(run.ts 의 `lostAnswerDetails`) — 표는 인자도 요청 id 도 보지 못하므로, 이 줄은 코드가
   * 아니라 실려 온 사실에서 나온다.
   *
   * **`retryCommand` 는 여기 오지 않는다.** 확인하기 전에 다시 보내는 것이 이 기능이 막으려는 바로
   * 그 행동이라, 그 줄은 `details` 에만 있다.
   */
  it('잃은 답의 요청 id 가 실려 있으면 그것을 묻는 줄이 맨 앞에 선다', () => {
    const details = {
      requestId: 'rq-1',
      queryCommand: 'astera requests show --id rq-1',
      retryCommand: 'astera worker-start --task tsk_1 --request-id rq-1'
    }
    expect(nextStepsFor({ code: 'TIMEOUT', cmd: 'worker-start', details })).toEqual([
      'astera requests show --id rq-1',
      'astera host status'
    ])
    // 그 줄이 없는 실패는 예전 그대로다 — 연결이 아예 안 선 끝에는 물어볼 영수증이 없다.
    expect(nextStepsFor({ code: 'HOST_NOT_RUNNING', cmd: 'worker-start' })).toEqual(['astera host start'])
  })

  /**
   * **이미 도는 요청이라 거절당한 6 은 다른 것을 묻는다**(요청 영수증 설계 §7). 그 거절이 말하는
   * "지금 상태" 는 Job 도 회차도 아니라 그 요청이고, `astera status` 는 그것에 대해 아무 말도 하지
   * 않는다. 런타임의 `pending` 문장이 시키는 "기다렸다 다시 묻기" 가 곧 이 줄이다.
   */
  it('요청이 이미 돌아서 난 6 은 그 요청을 묻는 줄로 간다', () => {
    expect(nextStepsFor({ code: 'CONFLICT', cmd: 'worker-start', details: { requestId: 'rq-1' } })).toEqual([
      'astera requests show --id rq-1'
    ])
    // 그 밖의 6 은 예전 그대로다 — 요청이 아니라 상태 때문에 거절된 것이므로 답은 "지금 무엇이 도는가" 다.
    expect(nextStepsFor({ code: 'CONFLICT', cmd: 'run-start' })).toEqual(['astera status'])
    expect(nextStepsFor({ code: 'CONFLICT', cmd: 'host-stop' })).toEqual(['astera host status'])
  })

  /**
   * **3 만은 순서가 뒤집힌다.** Host 에 닿지 못한 것이 그 코드의 뜻이고, 영수증을 묻는 명령도 Host 가
   * 있어야 답한다 — 목록을 위에서부터 따르는 에이전트는 "모르겠다" 를 한 번 더 받고 나서야 그것을
   * 고치는 줄에 닿는다. 그래서 Host 를 세우는 줄이 먼저고, 영수증은 그것이 답할 수 있게 된 뒤다.
   */
  it('3 에서는 Host 를 세우는 줄이 먼저고 영수증은 그 뒤다', () => {
    expect(
      nextStepsFor({
        code: 'HOST_NOT_RUNNING',
        cmd: 'worker-start',
        details: { queryCommand: 'astera requests show --id rq-1' }
      })
    ).toEqual(['astera host start', 'astera requests show --id rq-1'])
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
    // 공개 표면 밖의 명령에는 `--help` 가 없다. 산문 가이드가 아니라 스키마로 보낸다 —
    // 그것을 대신하려고 만든 명령이 그것을 권하면 앞뒤가 맞지 않는다.
    expect(nextStepsFor({ code: 'INVALID_ARGUMENTS', cmd: 'worker-start' })).toEqual([
      'astera agent-context'
    ])
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

// **시한을 넘긴 ask 는 실패가 아니다** — 질문은 여전히 열려 있고 여전히 사람을 기다린다. 그것을
// 실패로 읽고 다시 묻는 워커는 같은 사람에게 질문을 둘 만든다. 그래서 그 답에 "다시 기다리는 법"
// 이 실려야 하고, 실을 수 없으면 실을 수 없다고 말해야 한다.
describe('askTimeoutBody — 시한이 지난 ask', () => {
  it('질문 id 를 알면 그대로 칠 수 있는 줄을 싣는다', () => {
    expect(
      askTimeoutBody({ body: { answered: false, timedOut: true, questionId: 'msg_ab12cd34' }, args: {} })
    ).toEqual({
      answered: false,
      timedOut: true,
      questionId: 'msg_ab12cd34',
      nextSteps: ['astera ask --resume msg_ab12cd34']
    })
  })

  // 부르는 쪽이 고른 시한은 이 명령의 박자다. 그것을 잃은 줄은 같은 기다림이 아니다.
  it('부르는 쪽이 정한 시한은 그 줄에 남는다', () => {
    const r = askTimeoutBody({
      body: { answered: false, timedOut: true, questionId: 'msg_1' },
      args: { timeoutMs: 60000 }
    }) as { nextSteps: string[] }
    expect(r.nextSteps).toEqual(['astera ask --resume msg_1 --timeout-ms 60000'])
  })

  // **못 칠 줄을 주느니 못 준다고 말한다.** 자리표시자가 남은 `--resume <questionId>` 를 준 뒤에
  // 워커가 할 수 있는 일은 짐작이고, 짐작한 id 는 2 로 끝나거나 남의 질문을 기다린다.
  it('질문 id 가 없으면 명령 대신 그 사실을 말한다', () => {
    const r = askTimeoutBody({ body: { answered: false, timedOut: true }, args: {} }) as {
      nextSteps: string[]
      cannotResume: string
    }
    expect(r.nextSteps).toEqual([])
    // 이쪽은 답이 **왔다** — 무엇이 빠졌는지를 말한다. 아무것도 안 온 갈래의 문장과 다르다.
    expect(r.cannotResume).toContain('the answer did not name the question')
    expect(r.cannotResume).not.toContain('no answer came back at all')
  })

  // 답이 온 ask 와 다른 명령의 본문에는 손대지 않는다 — 기다림이 아닌 출력에 기다림의 안내를
  // 붙이면 그 안내가 아무것도 뜻하지 않게 된다.
  it('답이 온 ask 는 그대로 지나간다', () => {
    const answered = { answered: true, answer: '그대로 가라', questionId: 'msg_1' }
    expect(askTimeoutBody({ body: answered, args: {} })).toEqual(answered)
    expect(askTimeoutBody({ body: null, args: {} })).toBeNull()
  })
})

// 이쪽은 **답이 아예 오지 않은** 갈래다(run.ts 의 `stuck`). 질문은 만들어졌을 수도 있고 아닐
// 수도 있는데, 어느 쪽이든 다시 묻는 것은 최악이다.
describe('silentHostEnd — Host 가 답하지 않은 채 시한이 지났다', () => {
  it('--resume 으로 기다리던 중이면 그 id 를 그대로 다시 준다', () => {
    const end = silentHostEnd({ cmd: 'ask', args: { resume: 'msg_7' }, reason: '시한' })
    expect(end.details).toEqual({ questionId: 'msg_7' })
    expect(nextStepsFor({ code: 'TIMEOUT', cmd: 'ask', details: end.details })).toEqual([
      'astera ask --resume msg_7',
      'astera host status'
    ])
  })

  // **덜 아는 쪽이 더 나쁜 줄을 받으면 안 된다.** 답이 온 갈래는 인자를 보고 시한을 옮기는데,
  // 답이 안 온 이쪽만 그것을 잃으면 박자를 정한 호출자가 기본값으로 되돌아간다.
  it('부르는 쪽이 정한 시한은 이 갈래에서도 그 줄에 남는다', () => {
    const end = silentHostEnd({
      cmd: 'ask',
      args: { resume: 'msg_7', timeoutMs: 60000 },
      reason: '시한'
    })
    expect(end.details).toEqual({ questionId: 'msg_7', timeoutMs: 60000 })
    expect(nextStepsFor({ code: 'TIMEOUT', cmd: 'ask', details: end.details })).toEqual([
      'astera ask --resume msg_7 --timeout-ms 60000',
      'astera host status'
    ])
  })

  // **두 갈래의 문장이 다르다, 그리고 그것이 요점이다.** "답이 질문을 이름 붙이지 못했다" 를
  // 여기에 쓰면 답이 오기는 왔다고 — 따라서 질문은 만들어졌다고 — 가르치는 셈인데, 이 갈래에서
  // 이쪽이 아는 것은 정확히 그 반대다.
  it('새 질문이었으면 아무것도 안 왔다고 말한다, 답이 모자랐다고 말하지 않는다', () => {
    const end = silentHostEnd({ cmd: 'ask', args: { question: '어느 쪽인가' }, reason: '시한이 지났다' })
    expect(end.message).toContain('시한이 지났다')
    expect(end.message).toContain('no answer came back at all')
    expect(end.message).toContain('whether the question was created')
    expect(end.message).not.toContain('the answer did not name the question')
    expect(end.details).toEqual({})
    expect(nextStepsFor({ code: 'TIMEOUT', cmd: 'ask', details: end.details })).toEqual([
      'astera host status'
    ])
  })

  /**
   * **영수증이 생기면서 그 문장의 사실이 바뀌었다.** "질문이 만들어졌는지 알 길이 없다" 는 요청 id 를
   * 못 실은 부름에서만 참이다 — 실은 부름에서는 같은 봉투의 `nextSteps[0]` 이 바로 그것을 묻는
   * 명령이고, 한 봉투가 "알 수 없다" 와 "이렇게 물어봐라" 를 함께 말할 수는 없다.
   */
  it('요청 id 를 실었으면 그것을 먼저 물으라고 말한다', () => {
    const end = silentHostEnd({
      cmd: 'ask',
      args: { question: '어느 쪽인가' },
      reason: '시한이 지났다',
      request: 'rq-1'
    })
    expect(end.message).toContain('astera requests show --id rq-1')
    expect(end.message).toContain('whether the question was created')
    expect(end.message, '알 길이 없다는 옛 문장이 남아 있다').not.toContain('no way to tell from here')
    // 다시 묻지 말라는 것은 두 갈래 모두에서 그대로다 — 그것이 이 자리의 요점이다.
    expect(end.message).toContain('a second question in front of the same person')
  })

  it('다른 명령은 이유 한 줄 그대로다', () => {
    const end = silentHostEnd({ cmd: 'jobs-wait', args: { id: 'job_1' }, reason: '안 왔다' })
    expect(end).toEqual({ message: '안 왔다', details: {} })
    expect(nextStepsFor({ code: 'TIMEOUT', cmd: 'jobs-wait', details: end.details })).toEqual([
      'astera host status'
    ])
  })
})

// A profile file only the app can repair (the Host's `repair` field, lifted into `details`): the step is
// opening Astera, which no command does, so no command is offered. Any other 409 keeps its line.
describe('a CONFLICT that names a file to repair', () => {
  it('offers no command, carries the file, and exits 6', () => {
    const e = { code: 'CONFLICT' as const, message: 'accounts.json is not valid JSON; open Astera to repair it', details: { repair: 'accounts.json' } }
    expect(JSON.parse(errEnvelope(e, 'worker-start')).error).toEqual({
      code: 'CONFLICT',
      message: e.message,
      details: { repair: 'accounts.json' },
      nextSteps: []
    })
    expect(exitCodeFor(e.code)).toBe(6)
    expect(nextStepsFor({ code: 'CONFLICT', cmd: 'worker-start' })).toEqual(['astera status'])
  })
})

// Host S2 fix round, ruling (a): a 409 from a Host that is leaving is retried, not repaired or
// investigated. The step is the same command again (its line when the envelope carries one) once a
// Host is up, which `astera host status` shows.
describe('a CONFLICT a retiring Host answered', () => {
  it('offers the retry line when there is one, then astera host status', () => {
    expect(nextStepsFor({ code: 'CONFLICT', cmd: 'worker-start', details: { retry: 'host-retiring' } })).toEqual(['astera host status'])
    expect(
      nextStepsFor({ code: 'CONFLICT', cmd: 'worker-start', details: { retry: 'host-retiring', retryCommand: 'astera worker-start --task t1 --request-id rq-1' } })
    ).toEqual(['astera worker-start --task t1 --request-id rq-1', 'astera host status'])
  })
  // The final review of S4+S5, M6: a later `jobs run` made its run and then had its coordinator start
  // refused. The same `jobs run` again would make another run, so the step is the one its message names.
  it('for a later jobs run whose coordinator was refused, offers run-start for that run, not the same command', () => {
    expect(
      nextStepsFor({ code: 'CONFLICT', cmd: 'jobs-run', details: { retry: 'host-retiring', jobId: 'job_1', runId: 'run_2' } })
    ).toEqual(['astera host status', 'astera run-start --run run_2'])
  })
})

// `sessions send --wait` (CLI spec §15): the Host says how the turn ended; the exit code is decided here.
describe('sessionTurnEnd — how a waited turn exits', () => {
  it('a turn that ended is success, a failed one included (its error is in the body)', () => {
    expect(sessionTurnEnd({ id: 's1', sent: true, turn: { state: 'ended' } })).toBeNull()
    expect(sessionTurnEnd({ id: 's1', sent: true, turn: { state: 'ended', error: 'limit' } })).toBeNull()
  })

  it('a prompt is 8, carrying the session and the prompt id', () => {
    expect(
      sessionTurnEnd({ id: 's1', sent: true, turn: { state: 'prompt', promptId: 'req_1', prompt: { kind: 'approval', tool: 'Bash', summary: 'npm test' } } })
    ).toEqual({
      code: 'WAITING_FOR_INPUT',
      message: 'the turn stopped at a approval prompt (Bash: npm test), and it goes on once someone answers it',
      details: { sessionId: 's1', state: 'prompt', promptId: 'req_1', prompt: { kind: 'approval', tool: 'Bash', summary: 'npm test' } }
    })
    const terminal = sessionTurnEnd({ id: 's1', sent: true, enter: true, turn: { state: 'prompt', prompt: { kind: 'permission' } } })
    expect(terminal?.code).toBe('WAITING_FOR_INPUT')
    expect(terminal?.details).toEqual({ sessionId: 's1', state: 'prompt', promptId: null, prompt: { kind: 'permission' } })
  })

  it('a deadline is 7 and a session that ended is 1', () => {
    expect(sessionTurnEnd({ id: 's1', sent: true, turn: { state: 'timeout' } })?.code).toBe('TIMEOUT')
    expect(sessionTurnEnd({ id: 's1', sent: true, turn: { state: 'exited' } })?.code).toBe('FAILED')
  })

  it('a Host that sent and did not wait is 9: it is older than this CLI', () => {
    expect(sessionTurnEnd({ id: 's1', sent: true, enter: true })?.code).toBe('VERSION_MISMATCH')
  })

  it('what to run next: answer the prompt, or read the session', () => {
    expect(nextStepsFor({ code: 'WAITING_FOR_INPUT', cmd: 'sessions-send', details: { sessionId: 's1', promptId: 'req_1' } })).toEqual([
      'astera chats answer --id req_1 --allow --session s1',
      'astera sessions read --id s1'
    ])
    expect(nextStepsFor({ code: 'WAITING_FOR_INPUT', cmd: 'sessions-send', details: { sessionId: 's1', promptId: null } })).toEqual([
      'astera sessions read --id s1'
    ])
    expect(nextStepsFor({ code: 'TIMEOUT', cmd: 'sessions-send', details: { sessionId: 's1' } })).toEqual([
      'astera sessions read --id s1',
      'astera host status'
    ])
  })
})
