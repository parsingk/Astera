import { describe, expect, it } from 'vitest'
import { buildHandoverPrompt } from './handover'

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
