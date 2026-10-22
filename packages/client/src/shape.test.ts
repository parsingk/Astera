// What the public surface publishes (public CLI design §11), the rules publicFor keeps: an allowlist, never a
// blocklist; no field is invented; folded objects are shaped by the same rules. Moved from the app's
// cliPublic.test.ts with the code (SDK 1a); the app keeps the check that every internal field is listed or hidden.
import { describe, it, expect } from 'vitest'
import * as pkg from './internal.js'
import { publicEvent, publicFor } from './internal.js'

describe('publicFor', () => {
  it('허용된 칸만 남긴다', () => {
    const job = { id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: 'T', secret: 'x' }
    expect(publicFor('jobs-get', job)).toEqual({
      id: 'job_1',
      objective: 'o',
      cwd: 'D:/p',
      createdAt: 'T'
    })
  })

  // Phase 4 J15: where a Job came from is public
  it('keeps the job source a Job was made from', () => {
    const source = { id: 'astera-linear-source', itemId: 'ENG-1', label: 'Linear ENG-1', url: 'https://linear.app/x/ENG-1' }
    expect(publicFor('jobs-get', { id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: 'T', source })).toMatchObject({ source })
  })

  // Plugin Phase 4 J21: a Job made from a source is shaped as jobs create's Job
  it('shapes the Job jobs create-from-source makes as a Job', () => {
    const source = { id: 'github', itemId: '12', label: 'GitHub issue #12 in o/r' }
    const made = publicFor('jobs-create-from-source', { id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: 'T', source, internalField: 1 })
    expect(made).toMatchObject({ id: 'job_1', source })
    expect(made).not.toHaveProperty('internalField')
  })

  // GitHub lifecycle G1: a Job's lifecycle policy is public, a Run's raw GitHub record is not
  it('keeps a Job’s GitHub lifecycle policy and drops a Run’s raw GitHub record', () => {
    const github = { ci: { mode: 'selected', selectedChecks: ['build'] }, autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }
    expect(publicFor('jobs-get', { id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: 'T', github })).toMatchObject({ github })
    expect(publicFor('runs-get', { id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: 'T', githubState: { log: [], seq: 0 } })).not.toHaveProperty('githubState')
  })

  it('keeps a Run’s derived github field', () => {
    const github = { state: 'ci-pending', pr: { number: 12, url: 'u', isDraft: true, state: 'open' } }
    expect(publicFor('runs-get', { id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: 'T', github })).toMatchObject({ github })
  })

  // 없는 것을 undefined 로 찍으면 JSON 에서 사라져 결과는 같지만, 있는데 비어 있는 것과
  // 아예 없는 것이 한 모양이 된다
  it('없는 칸을 만들지 않는다', () => {
    expect(publicFor('projects-get', { id: 'proj_1', path: 'D:/p' })).toEqual({
      id: 'proj_1',
      path: 'D:/p'
    })
  })

  it('목록은 하나씩 가린다', () => {
    const out = publicFor('runs-list', [
      { id: 'run_1', jobId: 'job_1', ordinal: 1, internal: 1 },
      { id: 'run_2', jobId: 'job_1', ordinal: 2, internal: 2 }
    ])
    expect(out).toEqual([
      { id: 'run_1', jobId: 'job_1', ordinal: 1 },
      { id: 'run_2', jobId: 'job_1', ordinal: 2 }
    ])
  })

  // `jobs run` answers with the Run it started (runView), so it hides what `runs get` hides.
  it('jobs run hides the Run fields runs get hides', () => {
    const out = publicFor('jobs-run', {
      id: 'run_1',
      jobId: 'job_1',
      ordinal: 1,
      coordinatorStop: { at: 'T' },
      coordinatorStartingAt: 'T',
      coordinatorStopPending: true
    })
    expect(out).toEqual({ id: 'run_1', jobId: 'job_1', ordinal: 1 })
  })

  // `runs resume` answers with the Run it took back (runView), so it hides what `runs get` hides.
  it('runs resume hides the Run fields runs get hides', () => {
    const out = publicFor('runs-resume', { id: 'run_1', jobId: 'job_1', ordinal: 1, coordinatorStop: { at: 'T' } })
    expect(out).toEqual({ id: 'run_1', jobId: 'job_1', ordinal: 1 })
  })

  // **한 겹 안이라고 새면 가림막이 아니다.** jobs get 은 회차를 `run` 에 접어 싣는다(설계 §5)
  it('jobs get 이 접어 실은 회차도 가린다', () => {
    const out = publicFor('jobs-get', {
      id: 'job_1',
      objective: 'o',
      run: { id: 'run_1', jobId: 'job_1', ordinal: 1, internalNote: 'x' }
    }) as { run: Record<string, unknown> }
    expect(out.run).toEqual({ id: 'run_1', jobId: 'job_1', ordinal: 1 })
  })

  // 앱이 수렴을 굴리려고 적어 두는 장부다 — 내보내면 정책을 바꿀 때마다 남의 스크립트가 깨진다
  it('Task 의 수렴 장부는 내보내지 않는다', () => {
    const task: Record<string, unknown> = {
      id: 'task_1',
      title: 't',
      status: 'ready',
      checks: [],
      consecutiveFailures: 0,
      checkHistory: { c1: ['passed'] },
      policySnapshot: { key: 'k', capturedAt: 'T' },
      policyChanged: true,
      convergenceStartedAt: 'T',
      convergenceOff: true,
      suspiciousFiles: ['a.ts'],
      reviewRequested: true
    }
    const out = publicFor('tasks-list', [task]) as Record<string, unknown>[]
    expect(out[0]).toEqual({
      id: 'task_1',
      title: 't',
      status: 'ready',
      checks: [],
      consecutiveFailures: 0
    })
  })

  // 가이드가 코디네이터에게 읽으라고 말하는 칸들 — 가리면 오케스트레이션이 멈춘다
  it('가이드가 읽으라는 Task 칸은 남긴다', () => {
    const out = publicFor('tasks-list', [
      { id: 't1', parentId: 'p1', checks: [{ id: 'c' }], consecutiveFailures: 2, deps: ['t0'] }
    ]) as Record<string, unknown>[]
    expect(out[0]).toEqual({
      id: 't1',
      parentId: 'p1',
      checks: [{ id: 'c' }],
      consecutiveFailures: 2,
      deps: ['t0']
    })
  })

  // --brief 가 잘린 자리를 알리려고 만드는 칸이다. Task 에는 없으므로 따로 허용해야 한다
  it('tasks list --brief 가 덧붙이는 칸을 남긴다', () => {
    const out = publicFor('tasks-list', [
      { id: 't1', spec: '짧게', spec_truncated: true }
    ]) as Record<string, unknown>[]
    expect(out[0]).toEqual({ id: 't1', spec: '짧게', spec_truncated: true })
  })

  // GitHub lifecycle G3a: a lifecycle Task says what it is; the round it handed to the Host is the app's bookkeeping
  it('a lifecycle Task keeps its kind and never shows its handed-off round', () => {
    const out = publicFor('tasks-list', [{ id: 't1', kind: 'lifecycle', ciWait: { since: 'T', done: [] } }]) as Record<string, unknown>[]
    expect(out[0]).toEqual({ id: 't1', kind: 'lifecycle' })
  })

  // phase C 의 셋. 새 목록을 만들지 않는다 — 개체마다 한 목록이다(설계 §11).
  it('jobs create 는 계획으로, tasks add 는 Task 로 가린다', () => {
    expect(
      publicFor('jobs-create', { id: 'job_1', objective: 'o', pendingStart: true, outcome: 'running', secret: 1 })
    ).toEqual({ id: 'job_1', objective: 'o', pendingStart: true, outcome: 'running' })
    expect(publicFor('tasks-add', { id: 't1', jobId: 'job_1', reviewRequested: true, policyChanged: true }))
      .toEqual({ id: 't1', jobId: 'job_1' })
  })

  // `sessions send --wait` carries how the turn ended.
  it('sessions send 는 --wait 의 turn 을 싣는다', () => {
    expect(publicFor('sessions-send', { id: 's1', sent: true, enter: true, turn: { state: 'ended' }, secret: 1 })).toEqual({
      id: 's1',
      sent: true,
      enter: true,
      turn: { state: 'ended' }
    })
  })

  // `sessions create` answers the new session as `sessions list` shows it, and nothing of its note.
  it('sessions create 는 sessions list 의 한 줄과 같은 칸만 낸다', () => {
    expect(
      publicFor('sessions-create', { id: 's1', kind: 'chat', title: 't', accountId: 'a', cwd: 'D:/p', alive: true, state: 'unknown', rollAccountIds: ['a'] })
    ).toEqual({ id: 's1', kind: 'chat', title: 't', accountId: 'a', cwd: 'D:/p', alive: true, state: 'unknown' })
  })

  // `tasks dispatch` answers the worker the loop started: the spec file's path is the Host's own.
  it('tasks dispatch 는 Task·회차·Dispatch·세션·폴더만 낸다', () => {
    expect(
      publicFor('tasks-dispatch', { taskId: 't1', runId: 'r1', dispatchId: 'd1', sessionId: 's1', cwd: 'D:/wt', specPath: 'D:/p/orch/specs/d1.md' })
    ).toEqual({ taskId: 't1', runId: 'r1', dispatchId: 'd1', sessionId: 's1', cwd: 'D:/wt' })
  })

  // 구성은 명령·env·cwd 를 들고 있다 — env 값은 비밀일 수 있다. 앱이 이미 셋으로 추리지만 그래도 가린다.
  it('run-configs list 는 id·name·type 셋만 낸다', () => {
    expect(
      publicFor('run-configs-list', [
        { id: 'c1', name: 'test', type: 'npm', env: { TOKEN: 's3cret' }, command: 'npm test', cwd: 'D:/p' }
      ])
    ).toEqual([{ id: 'c1', name: 'test', type: 'npm' }])
  })

  it('accounts list 는 id·label·provider 셋만 낸다', () => {
    expect(
      publicFor('accounts-list', [{ id: 'a1', label: '일', provider: 'claude', configDir: 'C:/secret' }])
    ).toEqual([{ id: 'a1', label: '일', provider: 'claude' }])
  })

  // An added field: a row that is its provider's default says so, the others carry no `default`.
  it('accounts list keeps the default mark', () => {
    expect(
      publicFor('accounts-list', [
        { id: 'a1', label: 'one', provider: 'claude', default: true },
        { id: 'a2', label: 'two', provider: 'claude' }
      ])
    ).toEqual([
      { id: 'a1', label: 'one', provider: 'claude', default: true },
      { id: 'a2', label: 'two', provider: 'claude' }
    ])
  })

  // skills 의 답은 계정 목록 안에 스킬 목록이 접힌 모양이다. 두 겹 모두 같은 규칙으로 가린다 —
  // 계정의 configDir 도, 스킬 파일의 경로도 나가지 않는다.
  it('skills list 와 install 은 계정과 그 안의 스킬을 둘 다 가린다', () => {
    const account = {
      id: 'a1',
      label: '일',
      provider: 'claude',
      configDir: 'C:/secret',
      skills: [{ name: 'astera-task', enabled: true, installed: 'current', path: 'C:/secret/skills' }]
    }
    expect(publicFor('skills-list', { accounts: [account], extra: 1 })).toEqual({
      accounts: [
        { id: 'a1', label: '일', provider: 'claude', skills: [{ name: 'astera-task', enabled: true, installed: 'current' }] }
      ]
    })
    expect(
      publicFor('skills-install', {
        accounts: [{ ...account, skills: [{ name: 'astera-task', result: 'written', path: 'C:/secret' }] }],
        notEnabled: [{ name: 'astera-browser', setting: 'Settings → Agents → Agent browser', stubPath: 'x' }],
        note: 'n'
      })
    ).toEqual({
      accounts: [{ id: 'a1', label: '일', provider: 'claude', skills: [{ name: 'astera-task', result: 'written' }] }],
      notEnabled: [{ name: 'astera-browser', setting: 'Settings → Agents → Agent browser' }],
      note: 'n'
    })
  })

  // 세션의 note 는 앱이 자기에게 남긴 말이라 무엇이든 들 수 있다 — 일곱 칸만 나간다.
  it('sessions 셋은 제 칸만 낸다', () => {
    const row = { id: 's1', kind: 'terminal', title: 't', accountId: 'a', cwd: 'D:/p', alive: true, state: 'waiting', ptyId: 'p1' }
    expect(publicFor('sessions-list', [row])).toEqual([
      { id: 's1', kind: 'terminal', title: 't', accountId: 'a', cwd: 'D:/p', alive: true, state: 'waiting' }
    ])
    expect(
      publicFor('sessions-read', { id: 's1', alive: true, cols: 80, rows: 24, screen: ['hi'], scrollback: [], raw: 'x' })
    ).toEqual({ id: 's1', alive: true, cols: 80, rows: 24, screen: ['hi'], scrollback: [] })
    // The wrap marks are public (MCP P1 fix round 1): a reader joins a wrapped line with them.
    expect(
      publicFor('sessions-read', { id: 's1', screen: ['a', 'b'], scrollback: [], screenWrapped: [false, true], scrollbackWrapped: [] })
    ).toEqual({ id: 's1', screen: ['a', 'b'], scrollback: [], screenWrapped: [false, true], scrollbackWrapped: [] })
    // 대화 세션의 read — 턴 안과 카드 안도 같은 규칙으로 가린다. 한 겹 안이라고 새면 가림막이 아니다.
    expect(
      publicFor('sessions-read', {
        id: 'c1',
        kind: 'chat',
        alive: true,
        turns: [{ role: 'user', text: 'hi', tools: [], uuid: 'u1' }],
        pending: { kind: 'approval', summary: 'Bash: ls', requestId: 'r1' },
        threadId: 't'
      })
    ).toEqual({
      id: 'c1',
      kind: 'chat',
      alive: true,
      turns: [{ role: 'user', text: 'hi', tools: [] }],
      pending: { kind: 'approval', summary: 'Bash: ls' }
    })
    expect(publicFor('sessions-read', { id: 'c1', kind: 'chat', alive: true, turns: [], pending: null })).toEqual({
      id: 'c1',
      kind: 'chat',
      alive: true,
      turns: [],
      pending: null
    })
    expect(publicFor('sessions-send', { id: 's1', sent: true, enter: false, extra: 1 })).toEqual({
      id: 's1',
      sent: true,
      enter: false
    })
  })

  // **코디네이터 전용 명령은 이 계약의 약속 밖이다.** 가리려 들면 가이드가 시키는 것을 못 읽는다
  it('표에 없는 명령은 그대로 지나간다', () => {
    const body = { dispatchId: 'd1', anything: { nested: true } }
    expect(publicFor('dispatch-show', body)).toBe(body)
  })

  it('chats pending keeps the five prompt fields and complete; chats answer its four', () => {
    expect(publicFor('chats-pending', { prompts: [{ sessionId: 'c1', id: 'r1', kind: 'approval', tool: 'Bash', summary: 's', secret: 1 }], complete: true, extra: 1 }))
      .toEqual({ prompts: [{ sessionId: 'c1', id: 'r1', kind: 'approval', tool: 'Bash', summary: 's' }], complete: true })
    expect(publicFor('chats-answer', { sessionId: 'c1', id: 'r1', decision: 'deny', answered: true, extra: 1 }))
      .toEqual({ sessionId: 'c1', id: 'r1', decision: 'deny', answered: true })
  })
  // `runs checks` (CLI spec §20) folds four layers: the run, its Task rows, each row's validation and
  // review, and the checks and issues inside those. Every layer goes through its own list.
  it('runs checks 는 네 겹 모두 제 칸만 낸다', () => {
    const body = {
      runId: 'run_1',
      jobId: 'job_1',
      secret: 1,
      tasks: [
        {
          id: 't1',
          title: 'a',
          status: 'failed',
          policySnapshot: { key: 'k' },
          validation: {
            required: true,
            status: 'failed',
            configIds: ['x'],
            checks: [{ configId: 'c', name: 'build', status: 'failed', exitCode: 1, outputTail: 'e', env: 'SECRET=1' }]
          },
          review: {
            required: true,
            status: 'failed',
            verdict: 'rejected',
            dispatchId: 'd1',
            issues: [{ id: 'i', severity: 'high', blocking: true, title: 't', description: 'd', raw: 'x' }]
          },
          failureSummary: 'build failed (exit 1)',
          completionOverride: { reason: 'r', at: 'T' }
        }
      ]
    }
    expect(publicFor('runs-checks', body)).toEqual({
      runId: 'run_1',
      jobId: 'job_1',
      tasks: [
        {
          id: 't1',
          title: 'a',
          status: 'failed',
          validation: {
            required: true,
            status: 'failed',
            checks: [{ configId: 'c', name: 'build', status: 'failed', exitCode: 1, outputTail: 'e' }]
          },
          review: {
            required: true,
            status: 'failed',
            verdict: 'rejected',
            issues: [{ id: 'i', severity: 'high', blocking: true, title: 't', description: 'd' }]
          },
          failureSummary: 'build failed (exit 1)',
          completionOverride: { reason: 'r', at: 'T' }
        }
      ]
    })
  })

  // `runs follow` prints timeline events (CLI spec §22). A message event's body is a worker's whole
  // report, and a session id is the app's link to a tab: the line carries what happened, not those.
  it('runs follow 의 이벤트는 body 와 sessionId 를 내지 않는다', () => {
    expect(
      publicEvent({
        at: 'T',
        kind: 'message',
        sourceId: 'm1',
        taskId: 't1',
        taskTitle: 'a',
        messageType: 'worker_done',
        summary: 's',
        body: 'the whole report',
        outcome: 'succeeded',
        sessionId: 'sess_1'
      })
    ).toEqual({
      at: 'T',
      kind: 'message',
      sourceId: 'm1',
      taskId: 't1',
      taskTitle: 'a',
      messageType: 'worker_done',
      summary: 's',
      outcome: 'succeeded'
    })
  })

  // Agent Profiles design §6: the profile a Job or Task runs as is public, by its id
  it('keeps the agent profile a Job and a Task run as', () => {
    expect(publicFor('jobs-get', { id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: 'T', agentProfileId: 'ap_1' })).toMatchObject({ agentProfileId: 'ap_1' })
    expect(publicFor('tasks-add', { id: 't1', agentProfileId: 'ap_1' })).toEqual({ id: 't1', agentProfileId: 'ap_1' })
  })

  it('shapes the profiles the agent-profiles commands answer, listed, one, or as the CLI prints one', () => {
    const profile = { id: 'ap_1', name: 'Reviewer', status: 'active', accountIds: ['a'], mcpExclude: [], permission: 'ask', createdAt: 'T', updatedAt: 'T', secret: 'x' }
    const { secret: _s, ...shaped } = profile
    expect(publicFor('agent-profiles-list', { profiles: [profile], other: 1 })).toEqual({ profiles: [shaped] })
    expect(publicFor('agent-profiles-get', { profile })).toEqual({ profile: shaped })
    for (const cmd of ['agent-profiles-create', 'agent-profiles-update', 'agent-profiles-archive', 'agent-profiles-restore'])
      expect(publicFor(cmd, { profile }), cmd).toEqual({ profile: shaped })
    // The CLI prints one profile as `jobs get` prints a Job: the profile itself is its data
    for (const cmd of ['agent-profiles-show', 'agent-profiles-create', 'agent-profiles-update', 'agent-profiles-archive', 'agent-profiles-restore'])
      expect(publicFor(cmd, profile), cmd).toEqual(shaped)
  })

  it('객체가 아닌 것은 그대로 둔다', () => {
    expect(publicFor('jobs-list', [])).toEqual([])
    expect(publicFor('questions-get', null)).toBe(null)
  })
})

// Final review of SDK 1a, declined-to-judge items taken: a shared allowlist must not be widened by other code in the
// same process, and a command name that is also an Object.prototype key must not crash publicFor.
describe('the contract cannot be changed at run time', () => {
  it('freezes every public list and the exit table', () => {
    const lists = Object.entries(pkg).filter(([k]) => k.endsWith('_FIELDS') || k.endsWith('_CODES'))
    expect(lists.length).toBeGreaterThan(20)
    for (const [k, v] of lists) expect(Object.isFrozen(v), k).toBe(true)
  })

  it('passes a prototype key through untouched', () => {
    const body = { id: 'x', secret: 's' }
    expect(publicFor('constructor', body)).toBe(body)
    expect(publicFor('toString', body)).toBe(body)
    expect(publicFor('__proto__', body)).toBe(body)
  })
})

// SDK 1c: `runs-completion` was published whole. Its allowlist keeps every field it carries today (the completion
// read model publishes lastFailure, suspiciousFiles and policyChanged on purpose: it explains where a Task stands)
// and drops anything added later until someone lists it.
describe('publicFor runs-completion', () => {
  const full = {
    runId: 'run_1',
    jobId: 'job_1',
    state: 'exhausted',
    tasks: [
      {
        taskId: 'tsk_1',
        title: 't',
        state: 'exhausted',
        attempt: 3,
        maxAttempts: 3,
        detail: {
          taskId: 'tsk_1',
          checks: [{ configId: 'c', name: 'tests', status: 'failed', exitCode: 1, outputTail: 'x', unstable: true }],
          blockingIssues: [{ id: 'r', severity: 'high', blocking: true, title: 't', description: 'd', file: 'a.ts', line: 3, suggestedFix: 'f' }],
          otherIssueCount: 2,
          suspiciousFiles: ['x.ts'],
          policyChanged: true
        },
        failureSummary: 'tests failed',
        lastFailure: 'boom'
      },
      { taskId: 'tsk_2', title: 'u', state: 'converged', attempt: 0, maxAttempts: null, detail: null, failureSummary: null, lastFailure: null }
    ]
  }

  it('keeps every field the read model carries today', () => {
    expect(publicFor('runs-completion', full)).toEqual(full)
  })

  it('drops a field added at any level', () => {
    const extra = JSON.parse(JSON.stringify(full))
    extra.secret = 1
    extra.tasks[0].secret = 1
    extra.tasks[0].detail.secret = 1
    extra.tasks[0].detail.checks[0].secret = 1
    extra.tasks[0].detail.blockingIssues[0].secret = 1
    expect(publicFor('runs-completion', extra)).toEqual(full)
  })
})

// SDK 1d: the public events (SDK spec §6). The envelope is an allowlist like any answer, and the payload is the public
// DTO of its type, shaped by the same rules as the read that returns that object.
describe('the event types', () => {
  it('are the twenty-seven the Host produces, once each, frozen', () => {
    expect(pkg.EVENT_TYPES).toEqual([
      'job.created',
      'job.updated',
      'run.started',
      'run.completed',
      'run.failed',
      'task.started',
      'task.completed',
      'task.failed',
      'question.created',
      'question.answered',
      'completion.started',
      'completion.failed',
      'completion.repair_started',
      'completion.converged',
      'completion.exhausted',
      'session.input_needed',
      'session.limit_waiting',
      'session.account_switched',
      'github.pr_bound',
      'github.pr_created',
      'github.head_changed',
      'github.ci_passed',
      'github.ci_failed',
      'github.ci_rerun_requested',
      'github.source_changed',
      'github.merge_ready',
      'github.merge_ready_invalidated'
    ])
    expect(Object.isFrozen(pkg.EVENT_TYPES)).toBe(true)
  })
})

describe('shapeEvent', () => {
  const envelope = { id: 'ev_0123456789ab_1', sequence: 1, occurredAt: 'T', projectId: 'proj_1', jobId: 'job_1', runId: 'run_1', taskId: 'tsk_1' }

  it('keeps the envelope fields only and creates none', () => {
    expect(pkg.shapeEvent({ ...envelope, type: 'question.created', boot: 'x', payload: {} })).toEqual({ ...envelope, type: 'question.created', payload: {} })
    expect(pkg.shapeEvent({ id: 'ev_0123456789ab_2', type: 'job.created', sequence: 2, occurredAt: 'T', payload: {} })).toEqual({
      id: 'ev_0123456789ab_2',
      type: 'job.created',
      sequence: 2,
      occurredAt: 'T',
      payload: {}
    })
  })

  it('shapes a Job payload as jobs get does, without the folded Run', () => {
    const job = { id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: 'T', paused: true, outcome: 'paused', progress: { done: 0, total: 1 }, questionsOpen: 0 }
    expect(pkg.shapeEvent({ ...envelope, type: 'job.updated', payload: { ...job, run: { id: 'run_1' }, secret: 1 } })).toEqual({ ...envelope, type: 'job.updated', payload: job })
  })

  it('shapes a Run payload as runs list does, without waitingForApproval', () => {
    const run = { id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: 'T', outcome: 'completed', progress: { done: 1, total: 1 }, questionsOpen: 0 }
    expect(pkg.shapeEvent({ ...envelope, type: 'run.completed', payload: { ...run, waitingForApproval: 2, coordinatorStop: {} } })).toEqual({
      ...envelope,
      type: 'run.completed',
      payload: run
    })
  })

  it('shapes a Task payload, its checks and review issues included', () => {
    const task = {
      id: 'tsk_1',
      runId: 'run_1',
      title: 't',
      spec: 's',
      spec_truncated: false,
      deps: [],
      status: 'failed',
      checks: [{ configId: 'c', name: 'tests', status: 'failed', exitCode: 1 }],
      reviewIssues: [{ id: 'r', severity: 'high', blocking: true, title: 't', description: 'd' }],
      consecutiveFailures: 1,
      createdAt: 'T',
      updatedAt: 'T'
    }
    const extra = {
      ...task,
      checks: [{ ...task.checks[0], log: 'x' }],
      reviewIssues: [{ ...task.reviewIssues[0], reviewer: 'x' }],
      repairs: 2
    }
    expect(pkg.shapeEvent({ ...envelope, type: 'task.failed', payload: extra })).toEqual({ ...envelope, type: 'task.failed', payload: task })
  })

  it('shapes a Question payload', () => {
    const question = { id: 'gat_1', runId: 'run_1', taskId: 'tsk_1', question: 'q', status: 'resolved', resolution: 'retry', createdAt: 'T', resolvedAt: 'U' }
    expect(pkg.shapeEvent({ ...envelope, type: 'question.answered', payload: { ...question, answeredBy: 'x' } })).toEqual({
      ...envelope,
      type: 'question.answered',
      payload: question
    })
  })

  it('shapes a TaskCompletion payload at every level', () => {
    const row = {
      taskId: 'tsk_1',
      title: 't',
      state: 'fixing',
      attempt: 1,
      maxAttempts: 3,
      detail: { taskId: 'tsk_1', checks: [{ configId: 'c', name: 'tests', status: 'failed', exitCode: 1 }], blockingIssues: [], otherIssueCount: 0, suspiciousFiles: [], policyChanged: false },
      failureSummary: 'tests failed',
      lastFailure: 'tests failed'
    }
    const extra = JSON.parse(JSON.stringify(row))
    extra.secret = 1
    extra.detail.secret = 1
    extra.detail.checks[0].secret = 1
    expect(pkg.shapeEvent({ ...envelope, type: 'completion.repair_started', payload: extra })).toEqual({
      ...envelope,
      type: 'completion.repair_started',
      payload: row
    })
  })

  // Plugin Phase 3 (events and notifications design N2): a session event names its session, cut to five fields
  it('keeps a session event’s session id, and its payload’s fields only', () => {
    const session = { id: 's1', kind: 'terminal', title: 't', provider: 'claude', cwd: 'D:\p' }
    const raw = { id: 'ev_0123456789ab_3', type: 'session.input_needed', sequence: 3, occurredAt: 'T', sessionId: 's1', payload: { session: { ...session, accountId: 'a1', alive: true }, prompt: 'permission', note: 1 } }
    expect(pkg.shapeEvent(raw)).toEqual({ id: 'ev_0123456789ab_3', type: 'session.input_needed', sequence: 3, occurredAt: 'T', sessionId: 's1', payload: { session, prompt: 'permission' } })
    expect(pkg.shapeEvent({ ...raw, type: 'session.limit_waiting', payload: { session, scope: 'weekly', nextRetryAt: 'R', reattach: true } })).toEqual({ ...raw, type: 'session.limit_waiting', payload: { session, scope: 'weekly', nextRetryAt: 'R' } })
    expect(pkg.shapeEvent({ ...raw, type: 'session.account_switched', payload: { session, accountLabel: 'work', accountId: 'a2' } })).toEqual({ ...raw, type: 'session.account_switched', payload: { session, accountLabel: 'work' } })
  })

  it('gives an unknown type an empty payload', () => {
    expect(pkg.shapeEvent({ ...envelope, type: 'run.cancelled', payload: { id: 'run_1' } })).toEqual({ ...envelope, type: 'run.cancelled', payload: {} })
  })

  it('leaves what is not an object alone', () => {
    expect(pkg.shapeEvent(null)).toBe(null)
    expect(pkg.shapeEvent('x')).toBe('x')
  })
})

describe('publicFor events-poll', () => {
  it('keeps events, cursor and gap, and shapes each event', () => {
    const event = { id: 'ev_0123456789ab_1', type: 'question.created', sequence: 1, occurredAt: 'T', payload: { id: 'gat_1', secret: 1 }, boot: 'x' }
    expect(publicFor('events-poll', { events: [event], cursor: 'ev_0123456789ab_1', gap: false, extra: 1 })).toEqual({
      events: [{ id: 'ev_0123456789ab_1', type: 'question.created', sequence: 1, occurredAt: 'T', payload: { id: 'gat_1' } }],
      cursor: 'ev_0123456789ab_1',
      gap: false
    })
  })
})
