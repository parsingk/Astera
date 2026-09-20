import { describe, it, expect } from 'vitest'
import {
  DEFAULT_BLOCKING_SEVERITY,
  appendHistory,
  checkConfigIdsOf,
  isBlocking,
  isOverrideCompletion,
  latestImplDispatch,
  policyOf,
  repairCountOf,
  reviewRoundOf,
  timeBudgetExceeded,
  suspiciousCheckFiles,
  unstableChecks,
  type ResolvedPolicy
} from './convergence'
import { emptyState, type OrchState } from './state'
import { FAILURE_LIMIT, MAX_REVIEW_ROUNDS, type CheckResult, type Dispatch, type Run, type Task } from './types'

const T = '2026-09-19T00:00:00.000Z'
const run = (over: Partial<Run> = {}): Run => ({ id: 'run_1', objective: 'o', cwd: 'D:/p', createdAt: T, ...over })
const task = (over: Partial<Task> = {}): Task => ({
  id: 'tsk_1', runId: 'run_1', title: 't', spec: 's', deps: [], status: 'validating',
  consecutiveFailures: 0, createdAt: T, updatedAt: T, ...over
})
const dispatch = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'dsp_1', taskId: 'tsk_1', provider: 'claude', accountId: 'acc1', sessionId: 'sess1', cwd: 'D:/p',
  specPath: '', startedAt: T, workerState: 'stopped', retained: false, endedAt: T, outcome: 'succeeded', ...over
})
const state = (over: Partial<OrchState> = {}): OrchState => ({ ...emptyState(), runs: [run()], tasks: [task()], ...over })
const result = (configId: string, status: CheckResult['status']): CheckResult => ({ configId, name: configId, status })

describe('checkConfigIdsOf', () => {
  it('목록이 있으면 목록, 옛 단일 값만 있으면 그것 하나, 둘 다 없으면 빈 배열', () => {
    expect(checkConfigIdsOf({ validateConfigIds: ['a', 'b'], validateConfigId: 'z' })).toEqual(['a', 'b'])
    expect(checkConfigIdsOf({ validateConfigId: 'z' })).toEqual(['z'])
    expect(checkConfigIdsOf({})).toEqual([])
    expect(checkConfigIdsOf({ validateConfigIds: [] , validateConfigId: 'z' })).toEqual(['z'])
  })
})

describe('policyOf', () => {
  it('Run 에 convergence 가 없으면 null 이다', () => {
    expect(policyOf(state(), task())).toBeNull()
  })
  // 새 Run 모달이 기본값 셋을 회색 줄로 보여 준다 — 셋 다 상수에서 읽어야 상수가 바뀌는 날 화면이 거짓말하지 않는다
  it('빈 정책은 기본값 셋 — 심각도 기본은 DEFAULT_BLOCKING_SEVERITY 다', () => {
    expect(policyOf(state({ runs: [run({ convergence: {} })] }), task())).toEqual({
      maxFixAttempts: FAILURE_LIMIT, maxReviewRounds: MAX_REVIEW_ROUNDS, blockingSeverity: DEFAULT_BLOCKING_SEVERITY
    })
    expect(DEFAULT_BLOCKING_SEVERITY).toBe('high')
  })
  it('적힌 값은 그대로 쓴다', () => {
    const s = state({ runs: [run({ convergence: { maxFixAttempts: 1, maxReviewRounds: 5, blockingSeverity: 'medium' } })] })
    expect(policyOf(s, task())).toEqual({ maxFixAttempts: 1, maxReviewRounds: 5, blockingSeverity: 'medium' })
  })
})

describe('repairCountOf / reviewRoundOf / latestImplDispatch', () => {
  const s = state({
    dispatches: [
      dispatch({ id: 'dsp_1', startedAt: '2026-09-19T00:00:00.000Z' }),
      dispatch({ id: 'dsp_2', repair: 'check-failure', startedAt: '2026-09-19T00:01:00.000Z' }),
      dispatch({ id: 'dsp_r1', review: true, outcome: 'failed', startedAt: '2026-09-19T00:02:00.000Z' }),
      dispatch({ id: 'dsp_3', repair: 'review-failure', startedAt: '2026-09-19T00:03:00.000Z', endedAt: undefined, outcome: undefined, workerState: 'ready' }),
      dispatch({ id: 'dsp_r2', review: true, outcome: undefined, workerState: 'outcome_unknown', startedAt: '2026-09-19T00:04:00.000Z' })
    ]
  })
  it('판정을 낸 수리와 아직 도는 수리를 센다', () => {
    // dsp_2 는 판정을 냈고(outcome), dsp_3 은 아직 돈다(endedAt 없음)
    expect(repairCountOf(s, 'tsk_1')).toBe(2)
  })
  it('보고를 낸 검토 Dispatch 만 라운드로 센다 — 유실된 검토는 라운드를 먹지 않는다', () => {
    expect(reviewRoundOf(s, 'tsk_1')).toBe(1)
  })
  it('검토가 아닌 것 중 가장 늦게 시작한 Dispatch 가 마지막 구현·수리다', () => {
    expect(latestImplDispatch(s, 'tsk_1')?.id).toBe('dsp_3')
  })
  it('다른 Task 의 Dispatch 는 세지 않는다', () => {
    expect(repairCountOf(s, 'tsk_other')).toBe(0)
    expect(latestImplDispatch(s, 'tsk_other')).toBeUndefined()
  })
})

describe('isBlocking', () => {
  const high = { maxFixAttempts: 3, maxReviewRounds: 2, blockingSeverity: 'high' as const }
  const medium = { ...high, blockingSeverity: 'medium' as const }
  it('기본(high)에서는 critical·high 만 막는다', () => {
    expect(isBlocking('critical', high)).toBe(true)
    expect(isBlocking('high', high)).toBe(true)
    expect(isBlocking('medium', high)).toBe(false)
    expect(isBlocking('low', high)).toBe(false)
    expect(isBlocking('info', high)).toBe(false)
  })
  it('medium 으로 낮추면 medium 도 막는다', () => {
    expect(isBlocking('medium', medium)).toBe(true)
    expect(isBlocking('low', medium)).toBe(false)
  })
})

describe('appendHistory / unstableChecks', () => {
  it('passed·failed 만 쌓고 not-run 은 건너뛴다', () => {
    const h = appendHistory(undefined, [result('a', 'passed'), result('b', 'failed'), result('c', 'not-run')])
    expect(h).toEqual({ a: ['passed'], b: ['failed'] })
  })
  it('HISTORY_MAX(8) 를 넘으면 앞을 버린다', () => {
    let h: Record<string, ('passed' | 'failed')[]> | undefined
    for (let i = 0; i < 10; i++) h = appendHistory(h, [result('a', 'passed')])
    expect(h!.a).toHaveLength(8)
  })
  it('fail→pass→fail 또는 pass→fail→pass 가 보이는 check 가 unstable 이다', () => {
    expect(unstableChecks({ a: ['failed', 'passed', 'failed'] })).toEqual(['a'])
    expect(unstableChecks({ a: ['passed', 'failed', 'passed'] })).toEqual(['a'])
    expect(unstableChecks({ a: ['failed', 'failed', 'passed'] })).toEqual([])
    expect(unstableChecks({ a: ['failed', 'passed'] })).toEqual([])
  })
})

describe('suspiciousCheckFiles', () => {
  it('check 의 동작을 바꾸는 파일만 고른다', () => {
    expect(
      suspiciousCheckFiles([
        'package.json', 'src/a.ts', 'vitest.config.ts', 'jest.config.cjs', 'tsconfig.web.json',
        '.eslintrc.cjs', 'eslint.config.js', 'biome.json', '.github/workflows/ci.yml', 'sub/package.json', 'docs/x.md'
      ])
    ).toEqual([
      'package.json', 'vitest.config.ts', 'jest.config.cjs', 'tsconfig.web.json',
      '.eslintrc.cjs', 'eslint.config.js', 'biome.json', '.github/workflows/ci.yml', 'sub/package.json'
    ])
  })
  it('역슬래시 경로도 같은 규칙으로 본다', () => {
    expect(suspiciousCheckFiles(['.github\\workflows\\ci.yml'])).toEqual(['.github\\workflows\\ci.yml'])
  })
})

// 설계 G1(§47/§22). 바로 위 reviewRoundOf 가 "유실된 검토는 라운드를 먹지 않는다" 인데, repairCountOf
// 만 그 규칙을 어기고 있었다 — 일시정지가 닫은 수리도, 사람이 멈춘 수리도, 앱이 죽어 잃은 수리도
// 예산을 한 칸 먹었다. 그 시도는 판정을 낼 기회를 못 받았다.
describe('repairCountOf — 중단된 수리는 예산을 먹지 않는다', () => {
  const ended = (over: Partial<Dispatch>): Dispatch =>
    dispatch({ repair: 'check-failure', outcome: undefined, workerState: 'stopped', endedAt: T, ...over })

  it('일시정지가 닫은 수리는 세지 않는다', () => {
    const s = state({ dispatches: [ended({ id: 'd1', closedBy: 'pause' })] })
    expect(repairCountOf(s, 'tsk_1')).toBe(0)
  })

  it('사람이 멈춘 수리도, 포기한 수리도 세지 않는다', () => {
    const s = state({
      dispatches: [ended({ id: 'd1', closedBy: 'stop' }), ended({ id: 'd2', closedBy: 'abandon' })]
    })
    expect(repairCountOf(s, 'tsk_1')).toBe(0)
  })

  // 크래시로 잃은 수리 — 닫은 주체가 없어 closedBy 가 없다. 판정이 없다는 사실은 같다
  it('앱이 죽어 판정 없이 끝난 수리도 세지 않는다', () => {
    const s = state({ dispatches: [ended({ id: 'd1', workerState: 'outcome_unknown' })] })
    expect(repairCountOf(s, 'tsk_1')).toBe(0)
  })

  it('판정을 낸 수리는 실패여도 센다 — 기회를 받았다', () => {
    const s = state({
      dispatches: [dispatch({ id: 'd1', repair: 'check-failure', outcome: 'failed', endedAt: T })]
    })
    expect(repairCountOf(s, 'tsk_1')).toBe(1)
  })

  // 지금 도는 수리를 빼면 앱이 그 옆에 두 번째 수리를 연다
  it('아직 도는 수리는 판정이 없어도 센다', () => {
    const s = state({
      dispatches: [dispatch({ id: 'd1', repair: 'check-failure', outcome: undefined, endedAt: undefined, workerState: 'ready' })]
    })
    expect(repairCountOf(s, 'tsk_1')).toBe(1)
  })
})

// 설계 G2(명세 §40)
describe('timeBudgetExceeded', () => {
  const pol = (over: Partial<ResolvedPolicy> = {}): ResolvedPolicy => ({
    maxFixAttempts: 3, maxReviewRounds: 2, blockingSeverity: 'high', ...over
  })
  const started = '2026-09-19T00:00:00.000Z'
  const at = (min: number): number => Date.parse(started) + min * 60_000

  it('예산이 없으면 아무리 오래 돌아도 거짓 — 켠 적 없는 Run 이 첫 실패에 소진되면 안 된다', () => {
    expect(timeBudgetExceeded({ convergenceStartedAt: started }, pol(), at(10_000))).toBe(false)
  })

  it('시계가 아직 시작하지 않았으면 거짓', () => {
    expect(timeBudgetExceeded({}, pol({ maxTotalMinutes: 1 }), at(10_000))).toBe(false)
  })

  it('예산 안이면 거짓, 넘으면 참', () => {
    const p = pol({ maxTotalMinutes: 30 })
    expect(timeBudgetExceeded({ convergenceStartedAt: started }, p, at(29))).toBe(false)
    expect(timeBudgetExceeded({ convergenceStartedAt: started }, p, at(31))).toBe(true)
  })

  // 경계는 넘었을 때다 — 정확히 예산만큼 걸린 수리는 예산 안이다
  it('정확히 예산만큼은 넘긴 것이 아니다', () => {
    expect(timeBudgetExceeded({ convergenceStartedAt: started }, pol({ maxTotalMinutes: 30 }), at(30))).toBe(false)
  })

  // 손으로 고친 orchestration.json 에서만 나온다. 못 읽는 시각으로 예산을 끊지 않는다
  it('읽을 수 없는 시각이면 거짓', () => {
    expect(timeBudgetExceeded({ convergenceStartedAt: 'not-a-date' }, pol({ maxTotalMinutes: 1 }), at(9999))).toBe(false)
  })
})

// 설계 G4(명세 §30)
describe('isOverrideCompletion', () => {
  const pol: ResolvedPolicy = { maxFixAttempts: 3, maxReviewRounds: 2, blockingSeverity: 'high' }
  const chk = (status: CheckResult['status']): CheckResult => ({ configId: 'cfg1', name: 'Tests', status })

  it('자동 수정 없는 Run 이면 강제가 아니다 — 평범한 손보기다', () => {
    expect(isOverrideCompletion({ validateConfigIds: ['cfg1'] }, null)).toBe(false)
  })

  it('걸린 검사도 검토도 없으면 강제가 아니다 — 만족할 것이 없다', () => {
    expect(isOverrideCompletion({}, pol)).toBe(false)
  })

  // 통과를 본 적이 없다는 점에서 실패와 같다
  it('검사가 한 번도 돌지 않았으면 강제다', () => {
    expect(isOverrideCompletion({ validateConfigIds: ['cfg1'] }, pol)).toBe(true)
  })

  it('마지막 라운드에 통과 아닌 검사가 있으면 강제다', () => {
    expect(isOverrideCompletion({ validateConfigIds: ['cfg1'], checks: [chk('failed')] }, pol)).toBe(true)
    expect(isOverrideCompletion({ validateConfigIds: ['cfg1'], checks: [chk('timed-out')] }, pol)).toBe(true)
    expect(isOverrideCompletion({ validateConfigIds: ['cfg1'], checks: [chk('not-run')] }, pol)).toBe(true)
  })

  it('검사가 전부 통과했고 검토를 요구하지 않았으면 강제가 아니다', () => {
    expect(isOverrideCompletion({ validateConfigIds: ['cfg1'], checks: [chk('passed')] }, pol)).toBe(false)
  })

  it('막는 검토 지적이 남아 있으면 강제다', () => {
    const t = {
      validateConfigIds: ['cfg1'],
      checks: [chk('passed')],
      reviewRequested: true,
      reviewIssues: [{ id: 'i1', severity: 'high' as const, blocking: true, title: 't', description: 'd' }]
    }
    expect(isOverrideCompletion(t, pol)).toBe(true)
  })

  it('검토를 요구했는데 아직 받지 않았으면 강제다', () => {
    expect(isOverrideCompletion({ validateConfigIds: ['cfg1'], checks: [chk('passed')], reviewRequested: true }, pol)).toBe(true)
  })

  it('검사 통과 + 검토가 막지 않으면 강제가 아니다 — 수렴한 것이다', () => {
    const t = {
      validateConfigIds: ['cfg1'],
      checks: [chk('passed')],
      reviewRequested: true,
      reviewIssues: [{ id: 'i1', severity: 'low' as const, blocking: false, title: 't', description: 'd' }]
    }
    expect(isOverrideCompletion(t, pol)).toBe(false)
  })
})
