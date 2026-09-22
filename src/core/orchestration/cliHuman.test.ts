import { describe, it, expect } from 'vitest'
import { columns, displayWidth, humanFor, quietFor, stateWord } from './cliHuman'

describe('stateWord', () => {
  // 순서가 뜻이다 — 멈춘 것이 결과보다 앞선다
  it('멈춘 것과 아직 시작하지 않은 것이 결과를 이긴다', () => {
    expect(stateWord({ pendingStart: true, outcome: 'running' })).toBe('PENDING')
    expect(stateWord({ paused: true, outcome: 'running' })).toBe('PAUSED')
    expect(stateWord({ paused: true, schedule: { kind: 'daily' } })).toBe('PAUSED')
  })

  // 계획 자신은 돌지 않는다 — 도는 것은 발화가 만든 회차다
  it('예약은 결과가 아니라 예약이다', () => {
    expect(stateWord({ schedule: { kind: 'daily' }, outcome: 'running' })).toBe('SCHEDULED')
  })

  it('사람을 기다리는 것이 결과보다 앞선다', () => {
    expect(stateWord({ questionsOpen: 1, outcome: 'running' })).toBe('WAITING')
  })

  it('나머지는 Task 에서 나온 결과다', () => {
    expect(stateWord({ outcome: 'running' })).toBe('RUNNING')
    expect(stateWord({ outcome: 'completed' })).toBe('COMPLETE')
    expect(stateWord({ outcome: 'failed' })).toBe('FAILED')
    expect(stateWord({})).toBe('-')
  })
})

describe('displayWidth', () => {
  // **length 를 쓰면 한글 목록의 칸이 어긋난다** — 이 저장소의 Job 이름이 대개 한글이다
  it('한글·한자는 두 칸이다', () => {
    expect(displayWidth('매일 점검')).toBe(9)
    expect('매일 점검'.length).toBe(5)
    expect(displayWidth('astera')).toBe(6)
    expect(displayWidth('漢字')).toBe(4)
  })

  // UTF-16 두 칸을 차지하면서 한 글자다 — 코드포인트로 돌지 않으면 네 칸으로 센다
  it('이모지도 두 칸이다', () => {
    expect(displayWidth(String.fromCodePoint(0x1f680))).toBe(2)
  })
})

describe('columns', () => {
  // 목록의 칸이 맞는지는 이 줄로 정해진다 — 한글과 영문이 섞인 것이 보통이다
  it('한글과 영문이 섞여도 맞는다', () => {
    const out = columns([['매일 점검', 'x'], ['job', 'y']])
    expect(out).toBe(['매일 점검  x', 'job        y'].join('\n'))
  })

  it('칸을 맞춘다', () => {
    expect(columns([['a', 'xx'], ['bbb', 'y']])).toBe('a    xx\nbbb  y')
  })

  // 눈에 보이지 않는 공백이 줄 끝에 남으면 복사한 값이 조용히 달라진다
  it('마지막 칸은 채우지 않는다', () => {
    const out = columns([['a', 'long value'], ['b', 'x']])
    expect(out.split('\n').every((l) => l === l.trimEnd())).toBe(true)
  })

  it('빈 목록은 빈 글이다', () => {
    expect(columns([])).toBe('')
  })
})

describe('humanFor', () => {
  it('jobs list 는 상태를 맨 앞에 둔다', () => {
    const out = humanFor('jobs-list', {
      jobs: [
        { id: 'job_1', objective: '인증 손보기', outcome: 'running', progress: { done: 3, total: 7 } },
        { id: 'job_2', objective: '결제 이전', outcome: 'running', questionsOpen: 1 },
        { id: 'job_3', objective: '이름 바꾸기', outcome: 'completed', progress: { done: 5, total: 5 } }
      ]
    })
    expect(out).toBe(
      [
        'RUNNING   job_1  인증 손보기  3/7',
        'WAITING   job_2  결제 이전    1 question',
        'COMPLETE  job_3  이름 바꾸기  5/5'
      ].join('\n')
    )
  })

  it('질문이 여럿이면 복수로 센다', () => {
    const out = humanFor('jobs-list', {
      jobs: [{ id: 'j', objective: 'o', outcome: 'running', questionsOpen: 3 }]
    })
    expect(out).toContain('3 questions')
  })

  it('runs list 는 번호를 싣는다', () => {
    const out = humanFor('runs-list', {
      runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 3, outcome: 'completed', progress: { done: 2, total: 2 } }]
    })
    expect(out).toBe('COMPLETE  run_1  job_1  #3  2/2')
  })

  it('projects list 는 이름과 경로다', () => {
    expect(humanFor('projects-list', { projects: [{ id: 'p1', name: 'astera', path: 'D:/a' }] }))
      .toBe('p1  astera  D:/a')
  })

  it('tasks list 와 questions list 는 상태를 대문자로 앞에 둔다', () => {
    expect(humanFor('tasks-list', { tasks: [{ id: 't1', title: '제목', status: 'ready' }] }))
      .toBe('READY  t1  제목')
    expect(
      humanFor('questions-list', {
        questions: [{ id: 'g1', taskId: 't1', question: '어느 쪽인가', status: 'open' }]
      })
    ).toBe('OPEN  g1  t1  어느 쪽인가')
  })

  // 접어 실은 회차를 한 줄 JSON 으로 내면 읽으라고 만든 모드가 읽힐 수 없게 된다
  it('jobs get 은 접힌 회차를 들여써 펀쳐 쓴다', () => {
    const out = humanFor('jobs-get', {
      id: 'job_1',
      progress: { done: 1, total: 2 },
      run: { id: 'run_1', ordinal: 3, progress: { done: 1, total: 2 } }
    })
    expect(out).toBe(
      ['id        job_1', 'progress  1/2', '', 'run', '  id        run_1', '  ordinal   3', '  progress  1/2'].join('\n')
    )
  })

  // 진행은 사람이 가장 자주 읽는 값이다 — 목록과 같은 모양이어야 한다
  // 무엇을 내보낼지는 가림막이 이미 정했다 — 여기서 또 고르면 두 곳이 갈라진다
  it('단건은 가림막이 남긴 칸을 그대로 이름과 값으로 편다', () => {
    const out = humanFor('runs-get', { id: 'run_1', ordinal: 2, progress: { done: 1, total: 4 } })
    expect(out).toBe(['id        run_1', 'ordinal   2', 'progress  1/4'].join('\n'))
  })

  // features 는 배열이다 — fields() 가 객체를 다루는 자리(단건 칸)를 그대로 타므로 [object
  // Object] 가 아니라 읽을 수 있는 모양으로 나와야 한다.
  it('host status 는 배열 칸(features)도 읽을 수 있게 편다', () => {
    const out = humanFor('host-status', {
      running: true,
      pid: 42,
      version: '1.3.25',
      protocol: 3,
      features: ['proc', 'orch'],
      profile: 'D:/p',
      jobs: 3
    })
    expect(out).not.toContain('[object Object]')
    expect(out).toBe(
      [
        'running   true',
        'pid       42',
        'version   1.3.25',
        'protocol  3',
        'features  ["proc","orch"]',
        'profile   D:/p',
        'jobs      3'
      ].join('\n')
    )
  })

  // 억지로 표를 씌우면 가이드가 시키는 것을 못 읽게 된다
  it('공개 표면이 아닌 명령은 null 이다', () => {
    expect(humanFor('dispatch-show', { id: 'd1' })).toBe(null)
    expect(humanFor('worker-read', { items: [] })).toBe(null)
  })
})

describe('quietFor', () => {
  it('목록의 id 를 한 줄에 하나씩 낸다', () => {
    expect(quietFor({ jobs: [{ id: 'job_1' }, { id: 'job_2' }] })).toBe('job_1\njob_2')
  })

  it('단건은 그 id 하나다', () => {
    expect(quietFor({ id: 'run_1', ordinal: 1 })).toBe('run_1')
  })

  // 없는 것을 지어내는 것보다 빈 줄이 정직하다
  it('id 가 없으면 아무것도 내지 않는다', () => {
    expect(quietFor({ running: true, jobs: 3 })).toBe('')
    expect(quietFor({ cli: '1.0.0', app: null })).toBe('')
  })
})
