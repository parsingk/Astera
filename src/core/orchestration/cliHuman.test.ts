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

  // host-start 는 host-status 와 같은 몸을 낸다(runHostCommand 가 같은 hostStatus() 를 쓴다) — 표도
  // 같아야 한다. Task 2 의 수정에서 host-status 만 이 목록에 들어가고 host-start 는 빠졌었다.
  it('host start 도 host status 와 같은 표로 편다', () => {
    const out = humanFor('host-start', {
      running: true,
      pid: 42,
      version: '1.3.25',
      protocol: 3,
      features: ['proc', 'ping'],
      profile: 'D:/p',
      jobs: 0
    })
    expect(out).toBe(
      [
        'running   true',
        'pid       42',
        'version   1.3.25',
        'protocol  3',
        'features  ["proc","ping"]',
        'profile   D:/p',
        'jobs      0'
      ].join('\n')
    )
  })

  // host-stop 의 답도 평평한 칸이다(Task 4) — 세 host-* 명령을 나중에 갈라 넣을 이유가 없다.
  it('host stop 도 평평한 칸이면 표로 편다', () => {
    expect(humanFor('host-stop', { stopped: true, pid: 42 })).toBe(['stopped  true', 'pid      42'].join('\n'))
  })

  // 시한이 지난 ask 는 아무 일도 없이 돌아오므로 실패처럼 보인다 — 사람에게도 다음 수를 준다
  it('시한이 지난 ask 는 다시 기다리라는 문장과 그 줄이다', () => {
    expect(
      humanFor('ask', {
        answered: false,
        timedOut: true,
        questionId: 'msg_1',
        nextSteps: ['astera ask --resume msg_1']
      })
    ).toBe(
      [
        'the deadline passed and the question is still open. Do not ask again; keep waiting:',
        '  astera ask --resume msg_1'
      ].join('\n')
    )
  })

  // 칠 수 있는 줄이 없으면 그 사실이 문장이다 — 두 모드가 같은 칸에서 말한다
  it('다시 기다릴 수 없으면 왜인지를 말한다', () => {
    expect(
      humanFor('ask', { answered: false, timedOut: true, nextSteps: [], cannotResume: '이유' })
    ).toBe('the deadline passed and the question is still open, but 이유')
  })

  // 답이 온 ask 를 읽는 것은 워커이고, 워커가 읽는 것은 JSON 이다
  it('답이 온 ask 는 예전처럼 봉투로 되돌린다', () => {
    expect(humanFor('ask', { answered: true, answer: '그대로', questionId: 'msg_1' })).toBe(null)
  })

  // 계정×스킬 한 줄씩. install 은 설정이 꺼져 켜지 않은 스킬과 그 설정을 표 아래에 적는다.
  it('skills list 와 install 은 계정마다 스킬 한 줄이다', () => {
    const accounts = [
      { id: 'a1', provider: 'claude', skills: [{ name: 'astera-orchestration', enabled: true, installed: 'current' }] },
      { id: 'a2', provider: 'codex', skills: [{ name: 'astera-browser', enabled: false, installed: 'missing' }] }
    ]
    expect(humanFor('skills-list', { accounts })).toBe(
      ['a1  claude  astera-orchestration  on   current', 'a2  codex   astera-browser        off  missing'].join('\n')
    )
    expect(
      humanFor('skills-install', {
        accounts: [{ id: 'a1', provider: 'claude', skills: [{ name: 'astera-orchestration', result: 'written' }] }],
        notEnabled: [{ name: 'astera-browser', setting: 'Settings → Agents → Agent browser' }],
        note: 'Open a new session.'
      })
    ).toBe(
      [
        'a1  claude  astera-orchestration  written',
        '',
        'not enabled:',
        '  astera-browser  Settings → Agents → Agent browser',
        '',
        'Open a new session.'
      ].join('\n')
    )
  })

  it('accounts list 는 id·provider·label 이다', () => {
    expect(humanFor('accounts-list', { accounts: [{ id: 'a1', label: '일', provider: 'claude' }] }))
      .toBe('a1  claude  일')
  })

  it('run-configs list 는 id·type·name 이다', () => {
    expect(humanFor('run-configs-list', { runConfigs: [{ id: 'c1', name: 'test', type: 'npm' }] })).toBe(
      'c1  npm  test'
    )
  })

  it('jobs create 와 tasks add 는 단건처럼 편다', () => {
    expect(humanFor('jobs-create', { id: 'job_1', pendingStart: true })).toBe(
      ['id            job_1', 'pendingStart  true'].join('\n')
    )
    expect(humanFor('tasks-add', { id: 't1', status: 'ready' })).toBe(['id      t1', 'status  ready'].join('\n'))
  })

  it('sessions list 는 살았는지·하는 일·id·종류·제목이다', () => {
    expect(
      humanFor('sessions-list', {
        sessions: [
          { id: 's1', kind: 'terminal', title: 'repo', alive: true, state: 'working' },
          { id: 's2', kind: 'chat', title: '대화', alive: false, state: 'unknown' }
        ]
      })
    ).toBe(['ALIVE  working  s1  terminal  repo', 'ENDED  unknown  s2  chat      대화'].join('\n'))
  })

  // 읽으라고 부른 것이므로 화면 그대로다 — 표로 싸면 사람이 읽으려던 것을 가린다.
  it('sessions read 는 화면 글 그대로, sessions send 는 단건이다', () => {
    // 위의 줄들이 먼저, 그 아래 화면 — 터미널에서 보던 순서다.
    expect(humanFor('sessions-read', { id: 's1', alive: true, screen: ['c', 'd'], scrollback: ['a', 'b'] })).toBe(
      'a\nb\nc\nd'
    )
    expect(humanFor('sessions-send', { id: 's1', sent: true, enter: true })).toBe(
      ['id     s1', 'sent   true', 'enter  true'].join('\n')
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
