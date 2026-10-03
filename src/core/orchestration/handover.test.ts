import { describe, expect, it } from 'vitest'
import { buildHandoverPrompt, coordinatorLaunchPrompt } from './handover'

const prompt = (over: Partial<Parameters<typeof buildHandoverPrompt>[0]> = {}): string =>
  buildHandoverPrompt({
    runId: 'run_abc',
    objective: 'refactor the auth module',
    concurrency: 3,
    taskCount: 4,
    ...over
  })

describe('buildHandoverPrompt', () => {
  // 이 여섯 개가 계약이다 — 하나라도 빠지면 코디네이터가 지킬 수 없는 규칙이 생긴다
  // (handover.ts 의 JSDoc). 그래서 문구의 존재를 테스트가 고정한다.
  it('이 Run 은 사람이 짰다고 말한다 — 그대로 돌려라', () => {
    const p = prompt()
    expect(p).toContain('Do not create Tasks')
    expect(p).toContain('do not rewrite their specs')
    expect(p).not.toContain('PLAN THIS JOB FIRST')
  })

  // A Job from MCP create_job or `jobs create` reaches the Run with Tasks made elsewhere or none at
  // all, so the opening line must not claim the app (e2e 2026-10-01, second run).
  it('with Tasks, the opening line is true wherever the Tasks came from', () => {
    const p = prompt({ taskCount: 2 })
    expect(p).not.toContain('A person laid it out in the app')
    expect(p).toContain('Its Tasks were laid out before you joined')
  })

  // Review fix round 1, Important 1: the coordinator's session runs in the project folder itself,
  // with permissions bypassed, so nothing but the brief keeps it from doing the work itself.
  it('in both branches, the coordinator plans and places and changes no files', () => {
    for (const p of [prompt({ taskCount: 0 }), prompt({ taskCount: 3 })]) {
      expect(p).toContain('You plan and place; you do not change files.')
      expect(p).toContain("Your session runs in the project folder itself, not this Run's worktree.")
      expect(p).toContain('every edit, build or commit is done by a worker, through a Task')
      expect(p).not.toContain('Getting these Tasks done, and answering the workers you start, is your job.')
      expect(p).toContain('Getting these Tasks done by workers')
    }
  })

  // Review fix round 1, Minor 3: a predecessor stopped part-way through planning leaves Tasks that do
  // not cover the objective; "Do not create Tasks" alone left the newcomer no way to say so.
  it('with Tasks, the opening line holds for a coordinator joining late, and a plan that falls short goes to a Gate', () => {
    const p = prompt({ taskCount: 2 })
    expect(p).toContain('Its Tasks were laid out before you joined')
    expect(p).toContain('do not cover the objective')
    expect(p).toMatch(/open a Gate saying so/)
  })

  describe('with no Tasks, planning is the first job', () => {
    const p = prompt({ taskCount: 0, accountId: 'acc_me', jobId: 'job_42', runId: 'run_abc' })

    it('does not forbid creating Tasks, and says the Job came with no plan', () => {
      expect(p).not.toContain('Do not create Tasks')
      expect(p).not.toContain('THE PLAN IS ALREADY MADE')
      expect(p).not.toContain('A person laid it out')
      expect(p).toContain('PLAN THIS JOB FIRST')
      expect(p).toContain('an objective and no plan')
    })

    it('names the command, the deps, the account it runs on, and the checks', () => {
      expect(p).toContain('astera task-create --run run_abc')
      expect(p).toContain('--deps')
      expect(p).toContain('--account acc_me')
      expect(p).toContain('accounts list')
      expect(p).toContain('never mix providers inside one Task')
      expect(p).toContain('astera run-configs list --job job_42')
      expect(p).toContain('--validate')
      expect(p).toContain('--review')
      expect(p).toMatch(/few Tasks/)
    })

    it('says a Gate needs a Task, so a question before any Task goes on a first Task', () => {
      expect(p).toContain('A Gate needs a Task')
      expect(p).toContain('never ask only in your own terminal')
    })

    it('keeps the rest of the brief', () => {
      for (const part of ['TAKE STOCK BEFORE YOU START ANYTHING', 'ACCOUNTS COME FROM THE TASK', 'CONCURRENCY IS 3', 'WHERE WORKERS RUN', 'YOU ARE THE INBOX', 'WHEN A PERSON IS ACTUALLY NEEDED'])
        expect(p).toContain(part)
      expect(buildHandoverPrompt({ runId: 'r', objective: 'o', concurrency: 1, taskCount: 0, convergence: true })).toContain(
        'COMPLETION CONVERGENCE IS ON'
      )
    })
  })

  it('계정이 Task 에 있고 첫 계정이 provider 라고 말한다', () => {
    const p = prompt()
    expect(p).toContain('accountIds')
    expect(p).toContain('first account decides which CLI')
    expect(p).toContain('never mix providers inside one Task')
  })

  // 값은 run-show 로 읽을 수 있었지만 지키라고 말한 적이 없었다 — 그래서 숫자를 문구에 박는다
  it('동시 실행 한도를 숫자로 박아 넣는다', () => {
    expect(prompt({ concurrency: 3 })).toContain('CONCURRENCY IS 3')
    expect(prompt({ concurrency: 3 })).toContain('more than 3 dispatch')
    expect(prompt({ concurrency: 1 })).toContain('CONCURRENCY IS 1')
  })

  // 가이드가 "the placement rule" 을 이름만 부르고 정의를 두지 않았던 자리다
  it('배치 규칙이 한도에 따라 갈리고, 이유까지 적는다', () => {
    const seq = prompt({ concurrency: 1 })
    expect(seq).toContain('omit `--worktree`')
    expect(seq).not.toContain('--worktree new')

    const par = prompt({ concurrency: 2 })
    expect(par).toContain('--worktree new --name')

    for (const p of [seq, par]) {
      expect(p).toContain('merging the work back requires a clean tree')
      expect(p).toContain('overwrite each other')
    }
  })

  it('한도가 0 이거나 음수여도 순차로 읽는다 — 손으로 고친 파일이 그럴 수 있다', () => {
    for (const concurrency of [0, -1]) {
      expect(prompt({ concurrency })).toContain('omit `--worktree`')
    }
  })

  it('네가 받은편지함이고, 턴을 끝내면 아무것도 안 온다고 말한다', () => {
    const p = prompt()
    expect(p).toContain('check --wait')
    expect(p).toContain('If you end your turn, nothing reaches you')
    expect(p).toContain('reply --id')
  })

  it('사람이 필요할 때의 자리와 그 제약을 말한다', () => {
    const p = prompt()
    expect(p).toContain('gate-create')
    expect(p).toContain('cannot be created for a Task that has an open dispatch')
    expect(p).toContain('worker-stop')
  })

  it('Run 의 식별자와 목표를 싣는다 — 코디네이터가 --run 에 쓸 값이다', () => {
    const p = prompt({ runId: 'run_zzz', objective: '숫자를 센다', taskCount: 7 })
    expect(p).toContain('run_zzz')
    expect(p).toContain('숫자를 센다')
    expect(p).toContain('tasks already defined: 7')
  })

  it('convergence Run 의 브리핑은 재시도가 앱의 일이라고 말한다', () => {
    const p = buildHandoverPrompt({ runId: 'run_1', objective: 'o', concurrency: 1, taskCount: 2, convergence: true })
    expect(p).toContain('COMPLETION CONVERGENCE IS ON')
    expect(p).toContain('do not start a worker for it')
    expect(p).toContain('worker-release')
    expect(buildHandoverPrompt({ runId: 'run_1', objective: 'o', concurrency: 1, taskCount: 2 })).not.toContain('CONVERGENCE')
  })
})

// **이 계약이 깨지면 코디네이터는 빈 화면으로 선다.** 이 문구는 세션의 argv 로 가고 win32 에서
// 세션은 `cmd.exe /c` 로 뜨므로 줄바꿈이 명령을 끊는다 — 실측으로 그렇게 잡혔다(2026-08-28:
// 코디네이터는 떴지만 Task 가 돌지 않았고 그 세션에 트랜스크립트가 없었다).
describe('coordinatorLaunchPrompt', () => {
  it('한 줄이다', () => {
    const line = coordinatorLaunchPrompt('C:/x/orch/specs/coordinator-run_1.md')
    expect(line.split('\n')).toHaveLength(1)
    expect(line).not.toMatch(/[\r\n]/)
  })

  it('그 파일을 가리키고, 무엇인지 말한다', () => {
    const line = coordinatorLaunchPrompt('C:/x/brief.md')
    expect(line).toContain('C:/x/brief.md')
    expect(line).toContain('Job you are managing')
  })

  // 브리핑 본문은 여러 줄이어도 된다 — 파일로 가기 때문이다. 그 사실을 못박아 두지 않으면
  // 다음 사람이 "한 줄" 규칙을 브리핑 쪽으로 옮겨 읽는다
  it('브리핑 본문은 여러 줄이다 — 그것이 파일로 가는 이유다', () => {
    expect(
      buildHandoverPrompt({ runId: 'run_1', objective: 'o', concurrency: 1, taskCount: 1 }).split('\n')
        .length
    ).toBeGreaterThan(10)
  })
})
