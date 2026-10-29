import { describe, it, expect } from 'vitest'
import { completionDetailOf, completionForTaskOf, failedChecksSummary } from './completion'
import type { CheckResult, ReviewIssue, Task } from './types'

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  runId: 'r1',
  title: 'task',
  spec: '',
  deps: [],
  status: 'validating',
  consecutiveFailures: 0,
  createdAt: '2026-09-21T00:00:00.000Z',
  updatedAt: '2026-09-21T00:00:00.000Z',
  ...over
})
const check = (over: Partial<CheckResult> & Pick<CheckResult, 'configId' | 'name' | 'status'>): CheckResult => ({ ...over })
const issue = (over: Partial<ReviewIssue> & Pick<ReviewIssue, 'id' | 'severity' | 'blocking'>): ReviewIssue => ({
  title: 'issue',
  description: 'd',
  ...over
})

describe('a plugin check in the completion read model (plugin Phase 5 C12, C13)', () => {
  it('carries its summary, its findings, its link, and that a person skipped it', () => {
    const d = completionDetailOf(
      task({
        checks: [
          check({ configId: 'plugin:d', name: 'D', status: 'failed', summary: 's', diagnostics: [{ file: 'a.ts', line: 2, message: 'm' }], externalUrl: 'https://x.example/r' }),
          check({ configId: 'plugin:e', name: 'E', status: 'not-run', skipped: true, summary: 'Skipped by a person: down' }),
          check({ configId: 'plugin:f', name: 'F', status: 'error', summary: 'down' })
        ]
      })
    )!
    expect(d.checks).toEqual([
      { configId: 'plugin:d', name: 'D', status: 'failed', summary: 's', diagnostics: [{ file: 'a.ts', line: 2, message: 'm' }], externalUrl: 'https://x.example/r' },
      { configId: 'plugin:e', name: 'E', status: 'not-run', skipped: true, summary: 'Skipped by a person: down' },
      { configId: 'plugin:f', name: 'F', status: 'error', summary: 'down' }
    ])
  })

  // Task K fix round 1: and that its review ran with Claude Code's file-tool protection only
  it('carries that the review ran with file-tool protection only, which alone is something to show', () => {
    expect(completionDetailOf(task({ reviewFileToolsOnly: true }))).toMatchObject({ reviewFileToolsOnly: true })
    expect(completionDetailOf(task({ checks: [check({ configId: 'c', name: 'T', status: 'passed' })] }))).not.toHaveProperty('reviewFileToolsOnly')
  })

  // Task K (the person's Q1)
  it('carries that a check ran outside the sandbox its workers had', () => {
    const d = completionDetailOf(task({ checks: [check({ configId: 'c', name: 'Tests', status: 'passed', outsideSandbox: true })] }))!
    expect(d.checks).toEqual([{ configId: 'c', name: 'Tests', status: 'passed', outsideSandbox: true }])
  })

  // Task K fix round 2: and the names of what the Credentials list kept from it
  it('carries the variables the Credentials list kept from a check, by name', () => {
    const d = completionDetailOf(task({ checks: [check({ configId: 'c', name: 'Tests', status: 'failed', exitCode: 1, hiddenEnv: ['NPM_TOKEN'] })] }))!
    expect(d.checks).toEqual([{ configId: 'c', name: 'Tests', status: 'failed', exitCode: 1, hiddenEnv: ['NPM_TOKEN'] }])
  })

  it('names a failed plugin check by its summary in the failure summary, and leaves a check that could not be made out', () => {
    expect(failedChecksSummary([check({ configId: 'plugin:d', name: 'D', status: 'failed', summary: '2 leftovers' })])).toBe('D failed: 2 leftovers')
    expect(failedChecksSummary([check({ configId: 'plugin:d', name: 'D', status: 'error', summary: 'down' })])).toBeNull()
  })

  // Plugin Phase 5b Review Focus 5: the failure summary is one line, whatever line breaks a plugin's summary holds
  it('makes a plugin summary’s line breaks one space', () => {
    expect(failedChecksSummary([check({ configId: 'plugin:d', name: 'D', status: 'failed', summary: '3 leftovers\n  in 2 files\r\n' })])).toBe(
      'D failed: 3 leftovers in 2 files'
    )
  })
})

describe('completionDetailOf', () => {
  it('보여 줄 것이 하나도 없으면 null — 빈 블록과 "아직 안 왔다" 를 구별하게', () => {
    expect(completionDetailOf(task())).toBeNull()
  })

  // 5d: how many findings the plugin gave, when the Host kept fewer
  it('carries a plugin check’s count of findings', () => {
    const d = completionDetailOf(
      task({ checks: [check({ configId: 'plugin:d', name: 'D', status: 'failed', summary: 's', diagnostics: [{ message: 'm' }], diagnosticsTotal: 150 })] })
    )
    expect(d?.checks[0].diagnosticsTotal).toBe(150)
  })

  it('실패한 검사의 꼬리와 종료 코드를 그대로 나른다', () => {
    const d = completionDetailOf(
      task({
        checks: [
          check({ configId: 'tc', name: 'Typecheck', status: 'passed' }),
          check({ configId: 'ut', name: 'Tests', status: 'failed', exitCode: 1, outputTail: '2 failing' }),
          check({ configId: 'bd', name: 'Build', status: 'not-run' })
        ]
      })
    )
    expect(d?.checks.map((c) => c.name)).toEqual(['Typecheck', 'Tests', 'Build'])
    expect(d?.checks[1]).toEqual({
      configId: 'ut',
      name: 'Tests',
      status: 'failed',
      exitCode: 1,
      outputTail: '2 failing'
    })
  })

  // 통과한 검사는 애초에 꼬리를 저장하지 않는다(첫 조각 U2) — 여기서 지우는 것이 아니라 원래 없다.
  // 그래도 칸이 새로 생기지 않는 것은 고정해 둔다: 있으면 화면이 통과한 검사에도 [자세히] 를 낸다.
  it('통과한 검사에는 꼬리 칸 자체가 없다', () => {
    const d = completionDetailOf(task({ checks: [check({ configId: 'tc', name: 'Typecheck', status: 'passed' })] }))
    expect(d?.checks[0]).not.toHaveProperty('outputTail')
    expect(d?.checks[0]).not.toHaveProperty('exitCode')
    expect(d?.checks[0]).not.toHaveProperty('unstable')
  })

  it('불안정 표시는 살려서 나른다', () => {
    const d = completionDetailOf(
      task({ checks: [check({ configId: 'ut', name: 'Tests', status: 'failed', unstable: true })] })
    )
    expect(d?.checks[0].unstable).toBe(true)
  })

  it('막는 이슈만 펼치고 나머지는 개수로만 말한다', () => {
    const d = completionDetailOf(
      task({
        reviewIssues: [
          issue({ id: 'i1', severity: 'high', blocking: true, title: '경쟁 조건' }),
          issue({ id: 'i2', severity: 'low', blocking: false }),
          issue({ id: 'i3', severity: 'info', blocking: false })
        ]
      })
    )
    expect(d?.blockingIssues.map((i) => i.id)).toEqual(['i1'])
    expect(d?.otherIssueCount).toBe(2)
  })

  it('막는 이슈가 없어도 이슈가 있었다는 사실은 남는다', () => {
    const d = completionDetailOf(task({ reviewIssues: [issue({ id: 'i1', severity: 'low', blocking: false })] }))
    expect(d?.blockingIssues).toEqual([])
    expect(d?.otherIssueCount).toBe(1)
  })

  it('의심 파일만 있어도 블록은 열린다 — 검사 없이 검토만 걸린 Task', () => {
    const d = completionDetailOf(task({ suspiciousFiles: ['package.json'] }))
    expect(d?.suspiciousFiles).toEqual(['package.json'])
    expect(d?.checks).toEqual([])
  })
})

describe('completionForTaskOf', () => {
  const t1 = task({ id: 't1', runId: 'r1', suspiciousFiles: ['package.json'] })
  const t2 = task({ id: 't2', runId: 'r2', suspiciousFiles: ['tsconfig.json'] })

  it('그 Run 의 Task 면 투영한다', () => {
    expect(completionForTaskOf([t1, t2], 'r1', 't1')?.suspiciousFiles).toEqual(['package.json'])
  })

  // 이것이 이 함수가 있는 이유다 — Run 소유만 보고 taskId 를 믿으면 남의 Run 의 Task 를 읽는
  // 우회로가 된다
  it('다른 Run 의 Task 는 null', () => {
    expect(completionForTaskOf([t1, t2], 'r1', 't2')).toBeNull()
  })

  // 없는 Task 와 남의 Task 를 같은 null 로 답한다 — 구분해 주면 그 차이가 존재를 알려 주는 신호가 된다
  it('없는 Task 도 같은 null', () => {
    expect(completionForTaskOf([t1, t2], 'r1', 'nope')).toBeNull()
  })
})
