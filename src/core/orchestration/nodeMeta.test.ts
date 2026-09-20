import { describe, it, expect } from 'vitest'
import { convergenceChipOf, firstBlocked, firstBlockedCheck, nodeMetaOf, retryingCheckOf } from './nodeMeta'
import type { JobCheck, JobConvergence, JobTask } from '../types'

const check = (name: string, status: JobCheck['status']): JobCheck => ({ configId: name.toLowerCase(), name, status })
const conv = (over: Partial<JobConvergence> = {}): JobConvergence => ({
  repairs: 0, maxFixAttempts: 3, reviewRound: 0, maxReviewRounds: 2, repairing: null, stopped: false, ...over
})
const task = (over: Partial<JobTask> = {}): JobTask => ({ id: 't1', title: 't', status: 'dispatched', openGates: 0, ...over })
/** 셋 중 둘째가 막힌 라운드 — 첫 실패 뒤는 not-run 이다(validator) */
const failing = [check('Typecheck', 'passed'), check('Tests', 'failed'), check('Build', 'not-run')]

describe('firstBlocked', () => {
  it('첫 failed 나 timed-out 의 이름, 없으면 null', () => {
    expect(firstBlocked({ checks: failing })).toBe('Tests')
    expect(firstBlocked({ checks: [check('A', 'passed'), check('B', 'timed-out')] })).toBe('B')
    expect(firstBlocked({ checks: [check('A', 'passed')] })).toBeNull()
    expect(firstBlocked({})).toBeNull()
    expect(firstBlockedCheck({ checks: failing })?.configId).toBe('tests')
  })
})

describe('retryingCheckOf', () => {
  // 검토 실패로 되돌아온 Task 는 지난 라운드가 전부 통과했으니 검토까지 간 것이다 — firstBlockedCheck 는
  // null 을 주지만, 그 라운드는 다시 처음부터 돈다(고른 순서대로, 첫 실패에서 멈추는 validator 의 규칙)
  it('지난 라운드에 막힌 것이 없으면(검토 실패로 되돌아온 라운드) 첫 검사를 가리킨다', () => {
    const passedAll = [check('Typecheck', 'passed'), check('Tests', 'passed')]
    expect(retryingCheckOf(task({ status: 'validating', checks: passedAll }))?.name).toBe('Typecheck')
  })

  it('지난 라운드에 막힌 것이 있으면 그 검사를 가리킨다', () => {
    expect(retryingCheckOf(task({ status: 'validating', checks: failing }))?.name).toBe('Tests')
  })

  it('validating 이 아니면 null', () => {
    expect(retryingCheckOf(task({ status: 'dispatched', checks: failing }))).toBeNull()
  })

  it('검사 자체가 없으면(첫 라운드) null', () => {
    expect(retryingCheckOf(task({ status: 'validating' }))).toBeNull()
  })

  // ● 칩(RunDetail)과 meta 문구(nodeMetaOf)가 서로 다른 검사를 가리키면 안 된다 — checking.retrying 은 이
  // 함수를 그대로 쓴다
  it('nodeMetaOf 의 checking.retrying 과 항상 일치한다', () => {
    const passedAll = [check('Typecheck', 'passed'), check('Tests', 'passed')]
    const rerunningFromReview = task({ status: 'validating', checks: passedAll })
    const rerunningBlocked = task({ status: 'validating', checks: failing })
    expect(nodeMetaOf(rerunningFromReview)).toEqual({
      kind: 'checking',
      retrying: retryingCheckOf(rerunningFromReview)?.name ?? null
    })
    expect(nodeMetaOf(rerunningBlocked)).toEqual({
      kind: 'checking',
      retrying: retryingCheckOf(rerunningBlocked)?.name ?? null
    })
  })
})

describe('nodeMetaOf', () => {
  it('Gate 질문이 모든 것을 이긴다', () => {
    const t = task({
      status: 'blocked', gate: { id: 'g', question: '왜?' }, checks: failing, convergence: conv({ repairing: 'check-failure' })
    })
    expect(nodeMetaOf(t)).toEqual({ kind: 'gate', question: '왜?' })
  })

  it('repair 가 도는 중이면 수정 n/m 과 막힌 검사 — review-failure 면 검사 이름은 null', () => {
    expect(nodeMetaOf(task({ checks: failing, convergence: conv({ repairs: 2, repairing: 'check-failure' }) })))
      .toEqual({ kind: 'repairing', repairs: 2, max: 3, failed: 'Tests' })
    expect(nodeMetaOf(task({ checks: [check('A', 'passed')], convergence: conv({ repairs: 1, repairing: 'review-failure' }) })))
      .toEqual({ kind: 'repairing', repairs: 1, max: 3, failed: null })
  })

  // validator 는 라운드 끝에 한 번 결과를 주므로 도는 동안 아는 것은 지난 라운드뿐이다(UI 설계 U12) — "지금 도는
  // 검사" 를 지어내지 않고 지난 라운드에 막힌 것을 가리킨다. 첫 라운드면 가리킬 것이 없다.
  it('validating 은 지난 라운드에 막힌 검사를 다시 검사 중으로, 첫 라운드면 null', () => {
    expect(nodeMetaOf(task({ status: 'validating', checks: failing, provider: 'claude' }))).toEqual({ kind: 'checking', retrying: 'Tests' })
    expect(nodeMetaOf(task({ status: 'validating' }))).toEqual({ kind: 'checking', retrying: null })
  })

  it('reviewing 은 정책 있는 Run 에서만 라운드 — 진행 중인 라운드 번호다', () => {
    expect(nodeMetaOf(task({ status: 'reviewing', convergence: conv({ reviewRound: 1 }) }))).toEqual({ kind: 'reviewing', round: 2, max: 2 })
    expect(nodeMetaOf(task({ status: 'reviewing', provider: 'codex' }))).toEqual({ kind: 'provider', provider: 'codex' })
  })

  // 자동 수정 없는 Run 에서 검사가 깨진 Task — 시안의 Telemetry opt-out 카드. failed 상태에만 붙는 이유: --retry-of
  // 로 다시 띄운 dispatched Task 도 지난 라운드의 실패를 들고 있는데, 그 줄이 "실패" 라고 말하면 지금 도는 워커가
  // 없는 것처럼 읽힌다.
  it('failed 이고 막힌 검사가 있으면 그 이름, dispatched 로 다시 도는 중이면 provider', () => {
    expect(nodeMetaOf(task({ status: 'failed', checks: failing }))).toEqual({ kind: 'failed', name: 'Tests' })
    expect(nodeMetaOf(task({ status: 'dispatched', checks: failing, provider: 'claude' }))).toEqual({ kind: 'provider', provider: 'claude' })
    expect(nodeMetaOf(task({ status: 'failed' }))).toEqual({ kind: 'none' })
  })

  it('그 외는 provider, 그것도 없으면 none — 지금 화면 그대로', () => {
    expect(nodeMetaOf(task({ provider: 'claude' }))).toEqual({ kind: 'provider', provider: 'claude' })
    expect(nodeMetaOf(task({ status: 'completed' }))).toEqual({ kind: 'none' })
  })
})

describe('convergenceChipOf', () => {
  it('convergence 가 없으면 null — 자동 수정 없는 Run 의 줄은 그대로다', () => {
    expect(convergenceChipOf(task({ checks: failing, provider: 'claude' }))).toBeNull()
  })

  // repairs 로 되짚지 않는다 — grantedExtra 가 그 셈을 깨뜨린다(JobTask.gate 의 주석)
  it('소진은 gate.kind 로만', () => {
    expect(convergenceChipOf(task({
      status: 'blocked', gate: { id: 'g', question: 'q', kind: 'convergence-exhausted' }, convergence: conv({ repairs: 3 })
    }))).toEqual({ kind: 'exhausted' })
    expect(convergenceChipOf(task({
      status: 'blocked', gate: { id: 'g', question: 'q', kind: 'convergence-blocked' }, convergence: conv({ repairs: 3 })
    }))).toBeNull()
  })

  it('repair 중이면 수정 n/m, 검토 중이면 검토 n/m(진행 중인 라운드), 평범한 구현 Dispatch 면 null', () => {
    expect(convergenceChipOf(task({ convergence: conv({ repairs: 2, repairing: 'check-failure' }) }))).toEqual({ kind: 'repairing', repairs: 2, max: 3 })
    expect(convergenceChipOf(task({ status: 'reviewing', convergence: conv() }))).toEqual({ kind: 'reviewing', round: 1, max: 2 })
    expect(convergenceChipOf(task({ convergence: conv() }))).toBeNull()
  })
})
