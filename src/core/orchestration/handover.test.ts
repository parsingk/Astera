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
    expect(p).toContain('A person laid it out')
    expect(p).toContain('Do not create Tasks')
    expect(p).toContain('do not rewrite their specs')
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
