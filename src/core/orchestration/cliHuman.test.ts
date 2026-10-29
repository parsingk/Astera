import { describe, it, expect } from 'vitest'
import { columns, displayWidth, humanFor, quietFor, shellOf, stateWord } from './cliHuman'
import { ACTION_PHRASES, COVERAGE_NOTE_PHRASES } from '../audit/phrases'
import type { AuditAction, CoverageNote } from '../audit/types'
import { SANDBOX_COVERAGE } from '../sandbox/coverage'
import type { MessageKey } from '../i18n'
import { en } from '../i18n/messages/en'

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
    // A Job with no Run (jobs get, jobs list): not started, whether or not pendingStart is still set
    expect(stateWord({ outcome: 'pending' })).toBe('PENDING')
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

  // Plugin 4d: a Job made from a ticket is named by the ticket's title, not by the objective Astera wrote
  it('jobs list names a Job made from a ticket by its title', () => {
    const out = humanFor('jobs-list', {
      jobs: [
        {
          id: 'job_1',
          objective: 'Resolve Linear ENG-101 (https://linear.app/acme/issue/ENG-101).\n\nThe following is the item’s content',
          outcome: 'pending',
          progress: { done: 0, total: 0 },
          source: { id: 'astera-linear-source', itemId: 'ENG-101', label: 'Linear ENG-101', title: 'Fix the login page on Safari' }
        }
      ]
    })
    expect(out).toBe('PENDING  job_1  Fix the login page on Safari  0/0')
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

  // Plugin Phase 5 C6: what each plugin offers, so a person finds the plugin:<id> a Task's checks can name
  it('plugins list puts the status first in capitals, then the id, the version, what was granted and what it offers', () => {
    expect(
      humanFor('plugins-list', {
        plugins: [
          { id: '@acme/astera-jira', version: '1.0.0', status: 'stopped', permissions: ['jobs.read', 'jobs.create'], capabilities: ['completion-check'] },
          { id: 'astera-hello', version: '0.1.0', status: 'incompatible', permissions: [], capabilities: ['event', 'job-source'], reason: 'this Astera does not run event plugins yet' },
          { id: 'astera-plain', version: '0.1.0', status: 'running', permissions: [] }
        ]
      })
    ).toBe(
      [
        'STOPPED       @acme/astera-jira  1.0.0  jobs.read,jobs.create  completion-check',
        `INCOMPATIBLE  astera-hello       0.1.0  -${' '.repeat(22)}event,job-source  this Astera does not run event plugins yet`,
        `RUNNING       astera-plain       0.1.0  -${' '.repeat(22)}-`
      ].join('\n')
    )
  })

  // Agent Profiles design §6: a row per profile, its state first as plugins list does, then its id, name, permission,
  // sandbox switch (sandbox design §6; a profile from a Host before it reads as off) and accounts in order
  it('agent-profiles list is a row per profile, and one profile is its fields', () => {
    expect(
      humanFor('agent-profiles-list', {
        profiles: [
          { id: 'ap_1', name: 'Reviewer', status: 'active', accountIds: ['acc_a', 'acc_b'], mcpExclude: [], permission: 'ask', sandbox: true },
          { id: 'ap_2', name: 'Night', status: 'archived', accountIds: [], mcpExclude: ['m'], permission: 'inherit', sandbox: false },
          { id: 'ap_3', name: 'Old', status: 'active', accountIds: ['acc_a'], mcpExclude: [], permission: 'bypass' }
        ]
      })
    ).toBe(
      [
        'ACTIVE    ap_1  Reviewer  ask      on   acc_a,acc_b',
        'ARCHIVED  ap_2  Night     inherit  off  -',
        'ACTIVE    ap_3  Old       bypass   off  acc_a'
      ].join(String.fromCharCode(10))
    )
    expect(humanFor('agent-profiles-show', { id: 'ap_1', name: 'Reviewer' })).toContain('Reviewer')
    expect(humanFor('agent-profiles-delete', { id: 'ap_1', name: 'Reviewer', deleted: true })).toContain('ap_1')
  })

  it('plugins logs prints the lines, and says when there are none', () => {
    expect(humanFor('plugins-logs', { id: 'x', file: 'f', lines: ['one', 'two'] })).toBe('one' + String.fromCharCode(10) + 'two')
    expect(humanFor('plugins-logs', { id: 'x', file: 'f', lines: [] })).toBe('no log yet')
  })

  it('plugins doctor prints one line per check, a failure in capitals', () => {
    expect(
      humanFor('plugins-doctor', {
        id: 'x',
        ok: false,
        checks: [
          { name: 'manifest', ok: true, detail: 'x 1.0.0, Plugin API 1' },
          { name: 'native-addons', ok: true, warn: true, detail: '1 native addon (a.node)' },
          { name: 'entry', ok: false, detail: 'index.js is not a file' }
        ]
      })
    ).toBe(
      ['ok    manifest       x 1.0.0, Plugin API 1', 'warn  native-addons  1 native addon (a.node)', 'FAIL  entry          index.js is not a file'].join(String.fromCharCode(10))
    )
  })

  // Plugins 2c: a secret setting says only whether it is set.
  it('plugins settings prints one row per setting, a secret one only as set or not', () => {
    const data = {
      id: 'x',
      fields: [
        { key: 'baseUrl', type: 'string', required: true },
        { key: 'pageSize', type: 'integer', default: 50, required: false },
        { key: 'token', type: 'string', secret: true, required: true },
        { key: 'project', type: 'string', required: false }
      ],
      values: { baseUrl: 'https://jira.example.com', pageSize: 50 },
      secrets: { token: 'set' }
    }
    const expected = [
      'baseUrl   https://jira.example.com  required',
      'pageSize  50',
      'token     (secret, set)             required',
      'project   (not set)'
    ].join(String.fromCharCode(10))
    expect(humanFor('plugins-settings', data)).toBe(expected)
    expect(humanFor('plugins-configure', { ...data, restarted: true })).toBe(`${expected}${String.fromCharCode(10)}(restarted)`)
    expect(humanFor('plugins-settings', { id: 'x', fields: [], values: {}, secrets: {} })).toBe('no settings')
  })

  // 2c final review M6: configure says how the plugin stands, not only that it restarted.
  it('plugins configure ends with how the plugin stands after the change', () => {
    const lf = String.fromCharCode(10)
    const data = { id: 'x', fields: [{ key: 'token', type: 'string', secret: true, required: true }], values: {}, secrets: { token: 'set' } }
    const row = 'token  (secret, set)  required'
    expect(humanFor('plugins-configure', { ...data, status: 'running', restarted: true })).toBe(`${row}${lf}(restarted)`)
    expect(humanFor('plugins-configure', { ...data, status: 'running' })).toBe(`${row}${lf}(running)`)
    expect(humanFor('plugins-configure', { ...data, status: 'stopped', reason: 'needs settings: token; set them with astera plugins configure --id x' })).toBe(
      `${row}${lf}(stopped: needs settings: token; set them with astera plugins configure --id x)`
    )
    expect(humanFor('plugins-configure', { ...data, status: 'failed', reason: 'activate threw: x' })).toBe(
      `${row}${lf}(failed: activate threw: x; start it again with astera plugins enable --id x)`
    )
    expect(humanFor('plugins-settings', { ...data, status: 'running' })).toBe(row)
  })

  it('one plugin reads as its fields, like one project', () => {
    const one = { id: 'astera-hello', version: '0.1.0', status: 'disabled', enabled: false }
    for (const cmd of ['plugins-get', 'plugins-install', 'plugins-enable', 'plugins-disable', 'plugins-remove'])
      expect(humanFor(cmd, one), cmd).toBe(humanFor('projects-get', one))
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

  // One row per Task, and the failure under it: the summary is what a person reads the command for.
  it('runs checks 는 Task 마다 한 줄, 실패의 요약은 그 아래 줄이다', () => {
    expect(
      humanFor('runs-checks', {
        runId: 'run_1',
        tasks: [
          {
            id: 't1',
            title: '빌드',
            status: 'failed',
            validation: { status: 'failed' },
            review: { status: 'not-required', verdict: null },
            failureSummary: 'build failed (exit 1)'
          },
          {
            id: 't22',
            title: 'docs',
            status: 'completed',
            validation: { status: 'not-required' },
            review: { status: 'passed', verdict: 'accepted' },
            failureSummary: null
          }
        ]
      })
    ).toBe(
      [
        'FAILED     t1   validation failed        review not-required  빌드',
        '  build failed (exit 1)',
        'COMPLETED  t22  validation not-required  review passed        docs'
      ].join('\n')
    )
    expect(humanFor('runs-checks', { runId: 'run_1', tasks: [] })).toBe('(no tasks in run_1)')
  })

  // 5d (performance review H1): the Host keeps 20 findings and their count; the count says how many are not shown
  it('runs checks 는 Host 가 남기지 않은 지적까지 세어 "and N more" 로 말한다', () => {
    const kept = Array.from({ length: 20 }, (_, i) => ({ file: 'src/a.js', line: i + 1, message: 'adds TODO' }))
    const out = humanFor('runs-checks', {
      runId: 'run_1',
      tasks: [
        {
          id: 't1',
          title: 'login',
          status: 'failed',
          validation: { status: 'failed', checks: [{ configId: 'plugin:x', name: 'D', status: 'failed', summary: '150 leftovers', diagnostics: kept, diagnosticsTotal: 150 }] },
          review: { status: 'not-required' },
          failureSummary: 'D failed: 150 leftovers'
        }
      ]
    })
    expect(out?.split('\n')).toContain('    … and 145 more')
  })

  // Plugin Phase 5 C13: a plugin check's findings under its row, its link, one that could not run said so, and one a
  // person skipped. Every line a plugin wrote is one line here (Review Focus 5).
  it('runs checks 는 플러그인 검사의 지적 다섯 개와 링크, 할 수 없었던 검사와 건너뛴 검사를 줄 아래에 둔다', () => {
    const found = Array.from({ length: 7 }, (_, i) => ({ file: 'src/a.js', line: i + 1, message: i === 0 ? 'adds\nconsole.log' : 'adds TODO' }))
    const d = { configId: 'plugin:x', name: 'Debug leftovers' }
    expect(
      humanFor('runs-checks', {
        runId: 'run_1',
        tasks: [
          {
            id: 't1',
            title: 'login',
            status: 'failed',
            validation: {
              status: 'failed',
              checks: [{ ...d, status: 'failed', summary: '7 debug leftovers in 1 file', diagnostics: found, externalUrl: 'https://ci.example/1' }]
            },
            review: { status: 'not-required' },
            failureSummary: 'Debug leftovers failed: 7 debug leftovers in 1 file'
          },
          {
            id: 't2',
            title: 'docs',
            status: 'blocked',
            validation: { status: 'pending', checks: [{ configId: 'npm-test', name: 'test', status: 'passed' }, { ...d, status: 'error', summary: 'git diff: fatal:\nnot a git repository' }] },
            review: { status: 'not-required' },
            failureSummary: null
          },
          {
            id: 't3',
            title: 'api',
            status: 'completed',
            validation: { status: 'passed', checks: [{ ...d, status: 'not-run', skipped: true, summary: 'Skipped by a person: git is missing' }] },
            review: { status: 'not-required' },
            failureSummary: null
          }
        ]
      })
    ).toBe(
      [
        'FAILED     t1  validation failed   review not-required  login',
        '  Debug leftovers failed: 7 debug leftovers in 1 file',
        '    src/a.js:1 adds console.log',
        '    src/a.js:2 adds TODO',
        '    src/a.js:3 adds TODO',
        '    src/a.js:4 adds TODO',
        '    src/a.js:5 adds TODO',
        '    … and 2 more',
        '    Details: https://ci.example/1',
        'BLOCKED    t2  validation pending  review not-required  docs',
        '  Debug leftovers could not run: git diff: fatal: not a git repository',
        'COMPLETED  t3  validation passed   review not-required  api',
        '  Debug leftovers: Skipped by a person: git is missing'
      ].join('\n')
    )
  })

  // 5b final review M5, M6, M7: a round being run again shows nothing stale; a skipped check's line comes before the
  // failure it did not cause, so the findings sit under their own check; a round a person failed says why once
  it('runs checks 는 다시 도는 검사의 지난 줄을 내지 않고, 지적은 제 검사 아래에, 실패 처리된 검사는 한 번만 말한다', () => {
    const a = { configId: 'plugin:a', name: 'A' }
    const b = { configId: 'plugin:b', name: 'B' }
    const row = (id: string, status: string, validation: Record<string, unknown>, failureSummary: string | null) => ({
      id,
      title: id,
      status,
      validation,
      review: { status: 'not-required' },
      failureSummary
    })
    expect(
      humanFor('runs-checks', {
        runId: 'run_1',
        tasks: [
          row('t1', 'validating', { status: 'running', checks: [{ ...b, status: 'failed', summary: 'old', diagnostics: [{ file: 'x.js', line: 1, message: 'adds TODO' }] }, { ...a, status: 'error', summary: 'down' }] }, null),
          row('t2', 'failed', { status: 'failed', checks: [{ ...a, status: 'not-run', skipped: true, summary: 'Skipped by a person: down' }, { ...b, status: 'failed', summary: '1 leftover', diagnostics: [{ file: 'y.js', line: 2, message: 'adds TODO' }] }] }, 'B failed: 1 leftover'),
          row('t3', 'failed', { status: 'failed', checks: [{ ...a, status: 'error', summary: 'down' }] }, 'A could not run: down')
        ]
      })
    ).toBe(
      [
        'VALIDATING  t1  validation running  review not-required  t1',
        'FAILED      t2  validation failed   review not-required  t2',
        '  A: Skipped by a person: down',
        '  B failed: 1 leftover',
        '    y.js:2 adds TODO',
        'FAILED      t3  validation failed   review not-required  t3',
        '  A could not run: down'
      ].join('\n')
    )
  })

  // The last line of a follow that ended well. The other endings are errors and print as one (run.ts).
  it('runs follow 의 끝은 한 줄이다', () => {
    expect(humanFor('runs-follow', { state: 'completed', runId: 'run_1', progress: { done: 3, total: 3 } })).toBe(
      'run run_1 completed, 3/3 tasks done'
    )
  })

  // The protection column: `sandbox` (the CLI's own sandbox), `deny-only` (Claude Code on Windows), `sandboxed` for a kind
  // this build does not name, and `-` for a session outside the sandbox
  it('sessions list 는 살았는지·하는 일·id·종류·보호·제목이다', () => {
    expect(
      humanFor('sessions-list', {
        sessions: [
          { id: 's1', kind: 'terminal', title: 'repo', alive: true, state: 'working' },
          { id: 's2', kind: 'chat', title: '대화', alive: false, state: 'unknown' },
          { id: 's3', kind: 'terminal', title: 'box', alive: true, state: 'unknown', sandboxed: true, sandboxKind: 'sandbox' },
          { id: 's4', kind: 'chat', title: 'deny', alive: true, state: 'unknown', sandboxed: true, sandboxKind: 'deny-only' },
          { id: 's5', kind: 'chat', title: 'old', alive: true, state: 'unknown', sandboxed: true }
        ]
      })
    ).toBe(
      [
        'ALIVE  working  s1  terminal  -          repo',
        'ENDED  unknown  s2  chat      -          대화',
        'ALIVE  unknown  s3  terminal  sandbox    box',
        'ALIVE  unknown  s4  chat      deny-only  deny',
        'ALIVE  unknown  s5  chat      sandboxed  old'
      ].join('\n')
    )
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

  // 대화는 턴 단위로 — 누가 말했는지, 무슨 말을, 무엇을 돌렸는지. 기다리는 카드는 맨 끝에.
  it('대화 세션의 read 는 턴을 차례로, 열린 카드를 끝에 적는다', () => {
    expect(
      humanFor('sessions-read', {
        id: 'c1',
        kind: 'chat',
        alive: true,
        turns: [
          { role: 'user', text: '빌드 봐줘', tools: [] },
          { role: 'assistant', text: '고쳤습니다.\n\n지나갑니다.', tools: ['Bash npm run build (failed: exit 1)', 'Edit src/a.ts (ok)'] }
        ],
        pending: { kind: 'approval', summary: 'Bash: npm test' }
      })
    ).toBe(
      [
        'user:',
        '  빌드 봐줘',
        '',
        'assistant:',
        '  고쳤습니다.',
        '',
        '  지나갑니다.',
        '  [tool] Bash npm run build (failed: exit 1)',
        '  [tool] Edit src/a.ts (ok)',
        '',
        'waiting on an approval: Bash: npm test'
      ].join('\n')
    )
    expect(humanFor('sessions-read', { id: 'c1', kind: 'chat', alive: true, turns: [] })).toBe('(no turns yet)')
  })

  it('chats pending is one row per prompt: session, id, kind, tool, summary', () => {
    const out = humanFor('chats-pending', { prompts: [{ sessionId: 'c1', id: 'r1', kind: 'approval', tool: 'Bash', summary: 'Bash: ls' }], complete: true })
    expect(out).toMatch(/c1\s+r1\s+approval\s+Bash\s+Bash: ls/)
  })
  it('says so when Astera could not be asked', () => {
    expect(humanFor('chats-pending', { prompts: [], complete: false })).toMatch(/Astera could not be asked/)
  })
  it('says there are none for an empty complete list, and prints chats answer as fields', () => {
    expect(humanFor('chats-pending', { prompts: [], complete: true })).toBe('(no open prompts)')
    expect(humanFor('chats-answer', { sessionId: 'c1', id: 'r1', decision: 'deny', answered: true })).toMatch(/decision\s+deny/)
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

// Plugin Phase 4 J21: the job-source commands as a person reads them
describe('humanFor — the job-source commands', () => {
  it('lists the sources, ready or with why not', () => {
    expect(
      humanFor('sources-list', {
        sources: [
          { id: 'github', displayName: 'GitHub issues', ready: true, needsProject: true },
          { id: 'astera-linear-source', displayName: 'Linear', ready: false, reason: 'astera-linear-source is disabled', needsProject: false }
        ]
      })
    ).toBe(['READY      github                GitHub issues', 'NOT READY  astera-linear-source  Linear         astera-linear-source is disabled'].join('\n'))
  })

  it('lists a page of items with their Jobs, why one cannot be picked, and the next cursor', () => {
    expect(
      humanFor('sources-items', {
        items: [
          { id: 'ENG-1', title: 'Fix login', status: 'Todo', selectable: true, jobs: ['job_1'] },
          { id: '13', title: 'Add a thing', status: 'open', selectable: false, reason: 'written by a NONE', jobs: [] }
        ],
        nextCursor: 'c2'
      })
    ).toBe(['ENG-1  Todo  Fix login    job_1', '13     open  Add a thing  cannot be picked: written by a NONE', '', 'more: --cursor c2'].join('\n'))
    expect(humanFor('sources-items', { items: [], cut: true })).toBe("(no items)\n(cut to Astera's limits)")
  })

  it('shows an item: its fields, then its body as text', () => {
    expect(
      humanFor('sources-show', { id: 'ENG-1', title: 'Fix', status: 'Todo', body: 'It fails\non Safari', fields: { team: 'ENG' }, selectable: true, jobs: [] })
    ).toBe(['id          ENG-1', 'title       Fix', 'status      Todo', 'selectable  true', 'jobs        []', '', 'fields', '  team  ENG', '', 'It fails', 'on Safari'].join('\n'))
  })

  it('gives the Job made as jobs create does', () => {
    expect(humanFor('jobs-create-from-source', { id: 'job_1', objective: 'Resolve' })).toBe(humanFor('jobs-create', { id: 'job_1', objective: 'Resolve' }))
  })
})

// Observe mode design §11, §12: a call is shown by a plain phrase for its action, never by the action's name
describe('humanFor — audit and policies', () => {
  const two = (n: number): string => String(n).padStart(2, '0')
  /** The local time a person reads, as the table prints it. */
  const local = (iso: string): string => {
    const d = new Date(iso)
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
  }
  const push = { id: 'au_2', at: '2026-10-23T03:00:02.000Z', sessionId: 'sess_a', action: 'git.remote.write', target: 'git push', decision: 'would-deny', ruleId: 'starter-git-remote-write' }
  const read = { id: 'au_1', at: '2026-10-23T03:00:01.000Z', sessionId: 'sess_bb', action: 'filesystem.read', target: 'src/a.ts', decision: 'allow' }

  it('audit list is a row per call: time, session, what it did, its target, the decision and the rule', () => {
    expect(humanFor('audit-list', { records: [push, read], truncated: false, next: null })).toBe(
      [
        `${local(push.at)}  sess_a   git push to a remote  git push  would-deny  starter-git-remote-write`,
        `${local(read.at)}  sess_bb  read a file           src/a.ts  allow       -`
      ].join('\n')
    )
    expect(humanFor('audit-list', { records: [], truncated: false, next: null })).toBe('(no records)')
  })

  it('audit list prints a call the hook stopped as blocked, with what stopped it', () => {
    const stopped = { ...push, decision: 'blocked', ruleId: 'builtin-settings-command' }
    expect(humanFor('audit-list', { records: [stopped], truncated: false, next: null })).toBe(
      `${local(push.at)}  sess_a  git push to a remote  git push  blocked  builtin-settings-command`
    )
  })

  it('audit list says how to ask for the next page when the limit cut it', () => {
    const out = humanFor('audit-list', { records: [push], truncated: true, next: { until: push.at, beforeId: push.id } })
    expect(out?.split('\n').slice(-2)).toEqual(['', `more: --until ${push.at} --before-id ${push.id}`])
  })

  // Task 7 minor: the next page is the same question, so the hint repeats the filters that were used, in place of the
  // cursor they had
  it('audit list’s next page hint repeats the filters that were used', () => {
    const data = { records: [push], truncated: true, next: { until: push.at, beforeId: push.id } }
    const args = {
      session: 'sess_a', agentProfile: 'Reviewer Bot', action: 'git.*', decision: 'would-deny', since: '2026-10-23T00:00:00Z',
      until: '2026-10-24T00:00:00Z', beforeId: 'au_9', limit: 50
    }
    expect(humanFor('audit-list', data, args)?.split('\n').at(-1)).toBe(
      `more: --session sess_a --agent-profile 'Reviewer Bot' --action 'git.*' --decision would-deny --since 2026-10-23T00:00:00Z --limit 50 --until ${push.at} --before-id ${push.id}`
    )
  })

  // The hint is pasted into the shell the person types in: single quotes there never expand a `$`, and a quote in the
  // value is doubled in PowerShell and closed, escaped and reopened in a POSIX shell.
  it('audit list’s next page hint quotes each value for the shell it is pasted into', () => {
    const data = { records: [push], truncated: true, next: { until: push.at, beforeId: push.id } }
    const hint = (shell: 'powershell' | 'posix', args: Record<string, unknown>): string => humanFor('audit-list', data, args, shell)?.split('\n').at(-1) ?? ''
    const tail = ` --until ${push.at} --before-id ${push.id}`
    expect(hint('powershell', { agentProfile: "it's $HOME" })).toBe(`more: --agent-profile 'it''s $HOME'${tail}`)
    expect(hint('posix', { agentProfile: "it's $HOME" })).toBe(`more: --agent-profile 'it'\\''s $HOME'${tail}`)
    expect(hint('posix', { action: 'git.*', agentProfile: 'a b' })).toBe(`more: --agent-profile 'a b' --action 'git.*'${tail}`)
    // Only safe characters stay bare, and a number is text like the rest
    for (const shell of ['powershell', 'posix'] as const)
      expect(hint(shell, { session: 'sess_a', agentProfile: 'Reviewer.v2:x/y@z=1+2-3', limit: 50 })).toBe(
        `more: --session sess_a --agent-profile Reviewer.v2:x/y@z=1+2-3 --limit 50${tail}`
      )
    // A comma and a percent sign are not safe: PowerShell reads the one as an array and cmd the other as a variable
    expect(hint('powershell', { agentProfile: 'a,b%c' })).toBe(`more: --agent-profile 'a,b%c'${tail}`)
    // A leading @ is splatting in PowerShell
    expect(hint('powershell', { agentProfile: '@bot' })).toBe(`more: --agent-profile '@bot'${tail}`)
    // PowerShell ends a single quoted string at a curly single quote too: each of the four is doubled
    for (const quote of ['\u2018', '\u2019', '\u201A', '\u201B'])
      expect(hint('powershell', { agentProfile: `Bob${quote}s bot` }), quote).toBe(`more: --agent-profile 'Bob${quote}${quote}s bot'${tail}`)
    expect(hint('posix', { agentProfile: 'Bob’s bot' })).toBe(`more: --agent-profile 'Bob’s bot'${tail}`)
  })

  // The shell is told from the platform and the environment: Git Bash on Windows is win32 with a POSIX shell
  it('the hint is quoted for the shell the environment names', () => {
    expect(shellOf('win32', {})).toBe('powershell')
    expect(shellOf('win32', { MSYSTEM: 'MINGW64' })).toBe('posix')
    expect(shellOf('win32', { SHELL: '/usr/bin/bash' })).toBe('posix')
    expect(shellOf('win32', { SHELL: 'C:\\Program Files\\Git\\bin\\zsh.exe' })).toBe('posix')
    expect(shellOf('win32', { SHELL: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' })).toBe('powershell')
    expect(shellOf('linux', {})).toBe('posix')
    expect(shellOf('darwin', { SHELL: '/bin/zsh' })).toBe('posix')
  })

  // The parser takes a `-` as "read stdin" and a `--…` as the next flag, so no quoting makes them a value
  it('the hint leaves out a filter whose value the CLI could not take back, and says so', () => {
    const data = { records: [push], truncated: true, next: { until: push.at, beforeId: push.id } }
    for (const bad of ['-', '--x']) {
      const out = humanFor('audit-list', data, { session: 'sess_a', agentProfile: bad }, 'posix')?.split('\n')
      expect(out?.at(-1), bad).toBe(`more: --session sess_a --until ${push.at} --before-id ${push.id}`)
      expect(out?.at(-3), bad).toBe('(--agent-profile is not repeated below: its value cannot be given on the command line)')
    }
    // A single dash first is a plain value to the parser
    expect(humanFor('audit-list', data, { agentProfile: '-x' }, 'posix')?.split('\n').at(-1)).toBe(`more: --agent-profile '-x' --until ${push.at} --before-id ${push.id}`)
  })

  // Task 5 minor: the CLI's English is the screen's English, so the two cannot drift
  describe('the English the CLI prints is the one the screen says', () => {
    const screen = (key: MessageKey): string => en[key]
    const rowOf = (record: Record<string, unknown>): string => humanFor('audit-list', { records: [record], truncated: false, next: null }) ?? ''

    it('an action is its screen phrase, in audit list and in audit summary', () => {
      for (const action of Object.keys(ACTION_PHRASES) as AuditAction[]) {
        const phrase = screen(ACTION_PHRASES[action])
        expect(rowOf({ ...read, action }), action).toContain(`  ${phrase}  `)
        const summary = humanFor('audit-summary', { allow: 1, wouldDeny: 0, unknown: 0, byAction: { [action]: { allow: 1, wouldDeny: 0, unknown: 0 } } })
        expect(summary, action).toContain(phrase)
      }
    })

    it('a coverage note is its screen phrase', () => {
      for (const note of Object.keys(COVERAGE_NOTE_PHRASES) as CoverageNote[]) {
        const out = humanFor('policies-show', {
          mode: 'observe',
          policy: { rules: [], otherwise: 'allow' },
          coverage: [{ provider: 'claude', kind: 'chat', classes: { shell: { level: 'partial', note } } }]
        })
        expect(out, note).toContain(`partial (${screen(COVERAGE_NOTE_PHRASES[note])})`)
      }
    })

    // Where the CLI deliberately differs: its words are the ones a flag takes back (`--decision would-deny`), so a script
    // reads the table it prints and a person types what it says. The screen has its own label for the same three
    // decisions, five coverage classes and three levels (the keys exist there); the wording is the screen's to change.
    it('decisions, coverage classes and levels are the CLI’s own words, each with a screen label', () => {
      for (const d of ['allow', 'would-deny', 'unknown']) {
        expect(rowOf({ ...push, decision: d, ruleId: undefined }), d).toContain(`  ${d}  `)
        expect(Object.hasOwn(en, `settings.security.decision.${d}`), d).toBe(true)
      }
      const classes = { shell: { level: 'seen' }, 'file-read': { level: 'partial' }, 'file-write': { level: 'none' }, mcp: { level: 'seen' }, network: { level: 'none' } }
      const coverage = humanFor('policies-show', { mode: 'observe', policy: { rules: [], otherwise: 'allow' }, coverage: [{ provider: 'claude', kind: 'chat', classes }] })
      const [head, row] = (coverage ?? '').split('\n\n')[2].split('\n')
      expect(head.trim().split(/\s{2,}/)).toEqual(['shell', 'file read', 'file write', 'MCP', 'network'])
      expect(row.replace('claude chat', '').trim().split(/\s{2,}/)).toEqual(['seen', 'partial', 'none', 'seen', 'none'])
      for (const key of Object.keys(classes)) expect(Object.hasOwn(en, `settings.security.coverage.class.${key}`), key).toBe(true)
      for (const key of ['seen', 'partial', 'none']) expect(Object.hasOwn(en, `settings.security.coverage.level.${key}`), key).toBe(true)
    })
  })

  // Enforce: a count of the calls the hook stopped, shown once there are any, so an observe-only summary reads as before
  it('audit summary counts the blocked calls once there are any', () => {
    expect(
      humanFor('audit-summary', {
        allow: 1,
        wouldDeny: 0,
        unknown: 0,
        blocked: 2,
        byAction: { 'git.remote.write': { allow: 0, wouldDeny: 0, unknown: 0, blocked: 2 }, 'filesystem.read': { allow: 1, wouldDeny: 0, unknown: 0, blocked: 0 } },
        stoppedAtLimit: false
      })
    ).toBe(
      [
        'allow 1, would-deny 0, unknown 0, blocked 2',
        '',
        'git push to a remote  git.remote.write  allow 0  would-deny 0  unknown 0  blocked 2',
        'read a file           filesystem.read   allow 1  would-deny 0  unknown 0  blocked 0'
      ].join('\n')
    )
  })

  it('audit summary is the totals, then a row per action, the most seen first', () => {
    expect(
      humanFor('audit-summary', {
        allow: 2,
        wouldDeny: 2,
        unknown: 1,
        byAction: {
          'filesystem.read': { allow: 2, wouldDeny: 0, unknown: 0 },
          'git.remote.write': { allow: 0, wouldDeny: 2, unknown: 1 }
        },
        stoppedAtLimit: false
      })
    ).toBe(
      [
        'allow 2, would-deny 2, unknown 1',
        '',
        'git push to a remote  git.remote.write  allow 0  would-deny 2  unknown 1',
        'read a file           filesystem.read   allow 2  would-deny 0  unknown 0'
      ].join('\n')
    )
    const stopped = humanFor('audit-summary', { allow: 0, wouldDeny: 0, unknown: 0, byAction: {}, stoppedAtLimit: true })
    expect(stopped?.split('\n')[0]).toBe('allow 0, would-deny 0, unknown 0')
    expect(stopped).toContain('size limit')
  })

  const policy = {
    version: 1,
    mode: 'observe',
    rules: [
      { id: 'starter-git-remote-write', effect: 'deny', action: 'git.remote.write' },
      { id: 'starter-write-outside', effect: 'deny', action: 'filesystem.write', scope: 'outside-project' },
      { id: 'ar_1', effect: 'allow', action: 'git.*' }
    ],
    otherwise: 'allow'
  }
  const rules = [
    'mode       observe',
    'otherwise  allow',
    '',
    '0  deny   git.remote.write  anywhere         starter-git-remote-write',
    '1  deny   filesystem.write  outside-project  starter-write-outside',
    '2  allow  git.*             anywhere         ar_1'
  ]

  it('policies show is the mode, the rules in order with their place, and what observe can see', () => {
    const coverage = [
      { provider: 'claude', kind: 'terminal', classes: { shell: { level: 'seen' }, 'file-read': { level: 'seen' }, 'file-write': { level: 'seen' }, mcp: { level: 'seen' }, network: { level: 'partial', note: 'web-tools-only' } } },
      { provider: 'codex', kind: 'chat', classes: { shell: { level: 'seen' }, 'file-read': { level: 'partial', note: 'shell-text-only' }, 'file-write': { level: 'seen' }, mcp: { level: 'seen' }, network: { level: 'partial' } } }
    ]
    expect(humanFor('policies-show', { mode: 'observe', policy, coverage })).toBe(
      [
        ...rules,
        '',
        '                 shell  file read                  file write  MCP   network',
        'claude terminal  seen   seen                       seen        seen  partial (web tools only)',
        'codex chat       seen   partial (shell text only)  seen        seen  partial'
      ].join('\n')
    )
  })

  // Enforce: what it blocks while it is on, as the screen's table follows the mode
  it('policies show in enforce prints what enforce blocks', () => {
    const coverage = [{ provider: 'codex', kind: 'chat', classes: { shell: { level: 'seen' }, 'file-read': { level: 'seen' }, 'file-write': { level: 'seen' }, mcp: { level: 'seen' }, network: { level: 'seen' } } }]
    const enforceCoverage = [
      { provider: 'codex', kind: 'chat', classes: { shell: { level: 'enforced' }, 'file-read': { level: 'partial', note: 'shell-text-only' }, 'file-write': { level: 'enforced' }, mcp: { level: 'enforced' }, network: { level: 'partial' } } }
    ]
    const out = humanFor('policies-show', { mode: 'enforce', policy: { ...policy, mode: 'enforce' }, coverage, enforceCoverage })
    expect(out?.split('\n').at(-1)).toBe('codex chat  enforced  partial (shell text only)  enforced    enforced  partial')
    expect(humanFor('policies-show', { mode: 'observe', policy, coverage, enforceCoverage })).not.toContain('enforced')
  })

  // Sandbox design §6: what the sandbox blocks, a row per CLI and OS, under what observe or enforce covers; the network
  // reads allowed (E3), and a note is its screen phrase
  it('policies show prints what the sandbox blocks, one row per provider and OS', () => {
    const out = humanFor('policies-show', { mode: 'observe', policy, coverage: [], sandboxCoverage: SANDBOX_COVERAGE }) ?? ''
    const block = out.split('\n\n').at(-1)?.split('\n') ?? []
    const table = block.slice(0, 7)
    expect(table[0].trim().split(/\s{2,}/)).toEqual(['sandbox', 'write', 'login folders', 'OS secret store', 'network'])
    expect(table.slice(1).map((l) => l.split(/\s{2,}/)[0])).toEqual([
      'claude Windows',
      'claude macOS',
      'claude Linux',
      'codex Windows',
      'codex macOS',
      'codex Linux'
    ])
    // Task 8 fix round 1: beside the Claude Windows row, that its shell is not restricted
    expect(table[1].split(/\s{2,}/).slice(1)).toEqual(['none', 'partial (file tools only)', 'none', 'allowed', 'Windows: the shell is not restricted'])
    // Final fix pass (minor 5): every cell Claude's sandbox enforces on macOS and Linux says it was measured on the runtime
    expect(table[2].split(/\s{2,}/).slice(1)).toEqual(['enforced (measured on the runtime)', 'enforced (measured on the runtime)', 'enforced (measured on the runtime)', 'allowed'])
    expect(table[6].split(/\s{2,}/).slice(1)).toEqual(['enforced', 'enforced', 'enforced (when the session bus is a file path)', 'allowed'])
    // And under it, that the home stays readable outside the login folders
    expect(block.slice(7)).toEqual(["Outside the login folders, the home folder stays readable inside the sandbox. In a Claude session, commands the person types with `!` usually run outside the sandbox (see Claude Code's sandboxing docs); the agent's own commands run inside it."])
    // A Host that does not answer it prints the rules and the coverage as before
    expect(humanFor('policies-show', { mode: 'observe', policy })).toBe(rules.join('\n'))
  })

  it('a change answers the rules as they are now', () => {
    for (const cmd of ['policies-set-mode', 'policies-set-otherwise', 'policies-rules-add', 'policies-rules-edit', 'policies-rules-remove', 'policies-rules-move', 'policies-rules-reset'])
      expect(humanFor(cmd, { mode: 'observe', policy, rule: policy.rules[2] }), cmd).toBe(rules.join('\n'))
    expect(humanFor('policies-rules-reset', { mode: 'compatibility', policy: { ...policy, mode: 'compatibility', rules: [] } })?.split('\n').at(-1)).toBe('(no rules)')
  })
})

// The Credentials list (credentials design §7): a row per entry, never a value; doctor's lines with their level
describe('humanFor — credentials', () => {
  const list = {
    entries: [
      { kind: 'hide-only', id: 'hc_1', alias: 'Cloud', envNames: ['STRIPE_KEY'], presets: ['aws'], hide: { on: true, projects: ['D:/p'] }, createdAt: '2026-10-26T00:00:00.000Z' },
      { kind: 'mcp-secret', id: 'mcp:m1', serverId: 'm1', serverName: 'linear', secretNames: ['linear-key'], envNames: ['LINEAR_API_KEY'], protectedNames: [], hide: { on: false } }
    ],
    presets: []
  }
  it('lists each entry with its kind, what it hides and where', () => {
    const out = humanFor('credentials-list', list) ?? ''
    expect(out).toContain('Cloud')
    expect(out).toContain('STRIPE_KEY, preset aws')
    expect(out).toContain('hidden in D:/p')
    expect(out).toContain('linear')
    expect(out).toContain('not hidden')
    expect(out).not.toContain('linear-key')
    expect(humanFor('credentials-list', { entries: [], presets: [] })).toBe('(nothing listed)')
  })
  it('prints doctor’s lines with their level', () => {
    expect(humanFor('credentials-doctor', { lines: [{ level: 'ok', text: 'fine' }, { level: 'warn', text: 'careful' }] })).toBe(['ok    fine', 'warn  careful'].join('\n'))
  })
})
