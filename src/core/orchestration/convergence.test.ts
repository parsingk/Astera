import { describe, it, expect } from 'vitest'
import {
  appendHistory,
  checkConfigIdsOf,
  isBlocking,
  latestImplDispatch,
  policyOf,
  repairCountOf,
  reviewRoundOf,
  suspiciousCheckFiles,
  unstableChecks
} from './convergence'
import { emptyState, type OrchState } from './state'
import type { CheckResult, Dispatch, Run, Task } from './types'

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
  it('빈 정책은 기본값 3 / 2 / high 로 채운다', () => {
    expect(policyOf(state({ runs: [run({ convergence: {} })] }), task())).toEqual({
      maxFixAttempts: 3, maxReviewRounds: 2, blockingSeverity: 'high'
    })
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
  it('repair 표시가 있는 Dispatch 를 센다', () => {
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
