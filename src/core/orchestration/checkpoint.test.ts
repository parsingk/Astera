import { describe, it, expect } from 'vitest'
import {
  emptyState,
  createRun,
  createTask,
  openDispatch,
  applyWorkerDone,
  closeDispatch,
  recordStopSnapshot,
  createGate,
  resolveGate,
  type OrchState
} from './state'
import { buildCheckpoint, type GitSummary } from './checkpoint'

const NOW = '2026-08-26T00:00:00.000Z'

const unwrap = <T>(r: { ok: boolean } & Record<string, unknown>): { state: OrchState; value: T } => {
  if (!r.ok) throw new Error(`expected ok, got ${String(r.error)}`)
  return { state: r.state as OrchState, value: r.value as T }
}

const CREDENTIAL_BODY =
  'Implemented the redirect handler. Hit a snag with token refresh. Credential in use: ' +
  'ANTHROPIC_API_KEY=sk-ant-api03-FAKESECRETVALUE1234567890 — remove before continuing.'

/** state.test.ts 의 seed() 와 같은 방식(createRun -> createTask -> openDispatch, 전부 실제 함수)으로
 *  이 파일 전용 시나리오를 조립한다: 선행 Task 하나 -> 본 Task -> 첫 Dispatch 가 실패로 보고 ->
 *  재시도 Dispatch 가 usage limit 으로 멈춘다(closeDispatch) -> stopSnapshot 기록. */
function seed() {
  let { state: s, value: run } = unwrap<{ id: string }>(
    createRun(emptyState(), { objective: 'Implement OAuth login', cwd: 'D:/p' }, NOW) as never
  )
  const dep = unwrap<{ id: string }>(
    createTask(
      s,
      { runId: run.id, title: 'Add OAuth provider config', spec: 'Wire up client id/secret.', deps: [] },
      NOW
    ) as never
  )
  s = dep.state
  const main = unwrap<{ id: string }>(
    createTask(
      s,
      {
        runId: run.id,
        title: 'Implement Google OAuth callback',
        spec: 'Implement the callback handler and its tests.',
        deps: [dep.value.id]
      },
      NOW
    ) as never
  )
  s = main.state
  const d1 = unwrap<{ id: string; sessionId: string }>(
    openDispatch(
      s,
      {
        taskId: main.value.id,
        provider: 'codex',
        accountId: 'acc1',
        sessionId: 'sess1',
        cwd: 'D:/p/wt',
        specPath: 'D:/p/orch/specs/x.md'
      },
      NOW
    ) as never
  )
  s = d1.state
  const done1 = unwrap<'accepted' | 'alreadyReported'>(
    applyWorkerDone(
      s,
      {
        taskId: main.value.id,
        dispatchId: d1.value.id,
        outcome: 'failed',
        subject: 'callback handler in progress',
        body: CREDENTIAL_BODY,
        filesModified: ['src/auth/AuthService.ts', 'src/auth/GoogleOAuthProvider.ts']
      },
      NOW
    ) as never
  )
  s = done1.state
  const d2 = unwrap<{ id: string; sessionId: string }>(
    openDispatch(
      s,
      {
        taskId: main.value.id,
        provider: 'codex',
        accountId: 'acc1',
        sessionId: 'sess2',
        cwd: 'D:/p/wt',
        specPath: 'D:/p/orch/specs/x.md',
        retryOf: d1.value.id
      },
      NOW
    ) as never
  )
  s = d2.state
  // recordStopSnapshot 은 아직 끝나지 않은(!endedAt) Dispatch 만 찾으므로, closeDispatch 가
  // endedAt 을 찍기 전에 먼저 불러야 한다 — 실제 흐름도 정지 시점 측정이 종료 처리보다 앞선다.
  const snap = unwrap<unknown>(
    recordStopSnapshot(
      s,
      { sessionId: d2.value.sessionId, headCommit: 'abc123', transcriptBytes: 4096 },
      NOW
    ) as never
  )
  s = snap.state
  const limitResetsAt = Date.parse('2026-08-26T06:00:00.000Z')
  const closed = unwrap<{ id: string } | null>(
    closeDispatch(s, { sessionId: d2.value.sessionId, exitCode: 1, limitResetsAt }, NOW) as never
  )
  s = closed.state

  return { s, runId: run.id, taskId: main.value.id, depTaskId: dep.value.id, dispatchId: d2.value.id }
}

/** 보고 body 하나만 다른, 위 seed() 와 같은 조립. redaction 이 그 body 를 어떻게 다루는지만
 *  보려는 테스트가 쓴다 — seed() 는 이미 CREDENTIAL_BODY 를 심어 두므로 재사용할 수 없다. */
function seedWithReport(body: string): { s: OrchState; dispatchId: string } {
  const run = unwrap<{ id: string }>(
    createRun(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW) as never
  )
  const t = unwrap<{ id: string }>(
    createTask(run.state, { runId: run.value.id, title: 't', spec: 'do it', deps: [] }, NOW) as never
  )
  const d = unwrap<{ id: string }>(
    openDispatch(
      t.state,
      {
        taskId: t.value.id,
        provider: 'codex',
        accountId: 'acc1',
        sessionId: 'sess1',
        cwd: 'D:/p/wt',
        specPath: 'D:/p/orch/specs/x.md'
      },
      NOW
    ) as never
  )
  const done = unwrap<unknown>(
    applyWorkerDone(
      d.state,
      { taskId: t.value.id, dispatchId: d.value.id, outcome: 'failed', subject: 'progress', body },
      NOW
    ) as never
  )
  return { s: done.state, dispatchId: d.value.id }
}

const git: GitSummary = {
  branch: 'main',
  head: 'def456',
  changed: ['src/auth/GoogleOAuthProvider.ts', 'src/auth/AuthService.ts', 'tests/auth.test.ts'],
  diffstat: '3 files changed, 42 insertions(+), 5 deletions(-)'
}

describe('buildCheckpoint', () => {
  it('carries the job objective, task title, and task spec', () => {
    const { s, taskId, dispatchId } = seed()
    const c = buildCheckpoint(s, { dispatchId, git: null, now: NOW })
    expect(c).not.toBeNull()
    expect(c!.objective).toBe('Implement OAuth login')
    expect(c!.taskId).toBe(taskId)
    expect(c!.taskTitle).toBe('Implement Google OAuth callback')
    expect(c!.taskSpec).toBe('Implement the callback handler and its tests.')
  })

  it('carries dependency tasks with their titles and statuses', () => {
    const { s, dispatchId, depTaskId } = seed()
    const c = buildCheckpoint(s, { dispatchId, git: null, now: NOW })
    expect(c!.dependencies).toEqual([
      { id: depTaskId, title: 'Add OAuth provider config', status: 'ready' }
    ])
  })

  it('carries worker_done and status message bodies as what was done', () => {
    const { s, dispatchId } = seed()
    const c = buildCheckpoint(s, { dispatchId, git: null, now: NOW })
    const subjects = c!.reports.map((r) => r.subject)
    expect(subjects).toContain('callback handler in progress')
    expect(subjects).toContain('session ended at a usage limit')
  })

  it('merges Task.filesModified and the git summary changed files with no duplicates', () => {
    const { s, dispatchId } = seed()
    const c = buildCheckpoint(s, { dispatchId, git, now: NOW })!
    expect([...c.filesModified].sort()).toEqual(
      ['src/auth/AuthService.ts', 'src/auth/GoogleOAuthProvider.ts', 'tests/auth.test.ts'].sort()
    )
    expect(new Set(c.filesModified).size).toBe(c.filesModified.length)
  })

  it('flags that the worktree moved when stopSnapshot.headCommit differs from git.head', () => {
    const { s, dispatchId } = seed()
    const moved = buildCheckpoint(s, { dispatchId, git, now: NOW })!
    expect(moved.worktreeMoved).toBe(true)

    const notMoved = buildCheckpoint(s, { dispatchId, git: { ...git, head: 'abc123' }, now: NOW })!
    expect(notMoved.worktreeMoved).toBe(false)
  })

  it('leaves the git parts empty when git is null but still assembles the rest', () => {
    const { s, dispatchId } = seed()
    const c = buildCheckpoint(s, { dispatchId, git: null, now: NOW })!
    expect(c.git).toBeNull()
    expect(c.worktreeMoved).toBeNull()
    expect(c.objective).toBe('Implement OAuth login')
    expect(c.taskTitle).toBe('Implement Google OAuth callback')
    expect(c.filesModified).toEqual(
      expect.arrayContaining(['src/auth/AuthService.ts', 'src/auth/GoogleOAuthProvider.ts'])
    )
  })

  it('returns null for an unknown dispatchId', () => {
    const { s } = seed()
    expect(buildCheckpoint(s, { dispatchId: 'dsp_nope', git: null, now: NOW })).toBeNull()
  })

  it('does not let a credential in a message body survive into the checkpoint', () => {
    const { s, dispatchId } = seed()
    const c = buildCheckpoint(s, { dispatchId, git: null, now: NOW })!
    const serialized = JSON.stringify(c)
    expect(serialized).not.toContain('sk-ant-api03-FAKESECRETVALUE1234567890')
    expect(serialized).not.toContain('ANTHROPIC_API_KEY=sk-ant-api03-FAKESECRETVALUE1234567890')
  })

  // fix round 2: redaction 이 자격 증명이 아닌 것에 손대면 안 된다. report body 는 이 Phase 의
  // 중심 자산이고(DESIGN §20), 아래 문장은 워커가 실제로 쓰는 모양이다.
  it('leaves ordinary prose that merely mentions a token byte-identical', () => {
    const prose =
      'Fixed the token: it was being dropped by the interceptor. Branch sk-1042-fix-login is green.'
    const { s, dispatchId } = seedWithReport(prose)
    const c = buildCheckpoint(s, { dispatchId, git: null, now: NOW })!
    expect(c.reports.at(-1)?.body).toBe(prose)
  })

  it('still redacts a value that actually looks like a credential', () => {
    const body =
      'Left a note: token=sk-ant-api03-FAKESECRETVALUE1234567890 and a bare ' +
      'sk-ant-api03-OTHERFAKESECRETVALUE0987654321 plus Bearer eyJhbGciOiJIUzI1NiJ9fakejwt.';
    const { s, dispatchId } = seedWithReport(body)
    const serialized = JSON.stringify(buildCheckpoint(s, { dispatchId, git: null, now: NOW }))
    expect(serialized).not.toContain('sk-ant-api03-FAKESECRETVALUE1234567890')
    expect(serialized).not.toContain('sk-ant-api03-OTHERFAKESECRETVALUE0987654321')
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiJ9fakejwt')
    expect(serialized).toContain('[REDACTED]')
  })

  it('carries a resolved human decision from Gate.question/Gate.resolution', () => {
    let { state: s, value: run } = unwrap<{ id: string }>(
      createRun(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW) as never
    )
    const t = unwrap<{ id: string }>(
      createTask(s, { runId: run.id, title: 't', spec: 'do it', deps: [] }, NOW) as never
    )
    s = t.state
    const gate = unwrap<{ id: string }>(
      createGate(s, { taskId: t.value.id, question: 'Which token store?' }, NOW) as never
    )
    s = gate.state
    const resolved = unwrap<{ id: string }>(
      resolveGate(s, { gateId: gate.value.id, resolution: 'Use the existing KeyStore.' }, NOW) as never
    )
    s = resolved.state
    const d = unwrap<{ id: string }>(
      openDispatch(
        s,
        { taskId: t.value.id, provider: 'codex', accountId: 'a', sessionId: 'sx', cwd: 'D:/p', specPath: 'D:/p/spec.md' },
        NOW
      ) as never
    )
    s = d.state
    const c = buildCheckpoint(s, { dispatchId: d.value.id, git: null, now: NOW })!
    expect(c.decisions).toEqual([
      { question: 'Which token store?', status: 'resolved', resolution: 'Use the existing KeyStore.' }
    ])
  })
})
