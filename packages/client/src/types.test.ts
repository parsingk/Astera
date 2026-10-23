// The DTOs are types only: nothing in types.ts runs. The samples below are the reference's (docs/superpowers/specs/
// 2026-10-12-sdk-1c-command-reference.md §C) and must keep compiling against the DTOs (`satisfies`): a DTO that
// loses or retypes a field the Host sends breaks the package typecheck here.
import { describe, it, expect } from 'vitest'
import * as types from './types.js'
import type {
  AgentProfile,
  AnsweredQuestion,
  AsteraEvent,
  EventGap,
  EventList,
  EventSession,
  Job,
  JobWithRun,
  ListResult,
  Project,
  Question,
  Run,
  RunCompletion,
  RunEvent,
  StopResult,
  Task,
  TaskDetail,
  WaitResult
} from './types.js'

const project = { id: 'proj_1', path: 'D:\\p', name: 'p', addedAt: 'T' } satisfies Project
const job = {
  id: 'job_1',
  objective: 'o',
  cwd: 'D:\\p',
  projectId: 'proj_1',
  createdAt: 'T',
  concurrency: 2,
  coordinatorAccountId: 'acc',
  autoDispatch: true,
  schedule: { kind: 'weekly', weekdays: [1, 3], time: '09:00' },
  fireCount: 1,
  pendingStart: true,
  paused: false,
  convergence: { maxFixAttempts: 3, blockingSeverity: 'high' },
  agentProfileId: 'ap_000000000001',
  outcome: 'pending',
  progress: { done: 0, total: 2 },
  questionsOpen: 0
} satisfies Job
const run = {
  id: 'run_1',
  jobId: 'job_1',
  ordinal: 1,
  createdAt: 'T',
  worktree: 'D:\\w',
  git: { base: 'a', head: 'b' },
  outcome: 'running',
  progress: { done: 1, total: 2 },
  questionsOpen: 1,
  waitingForApproval: 1
} satisfies Run
const task = {
  id: 'tsk_1',
  runId: 'run_1',
  title: 't',
  spec: 's',
  deps: [],
  status: 'failed',
  checks: [{ configId: 'c', name: 'tests', status: 'failed', exitCode: 1, outputTail: 'x', unstable: true }],
  reviewIssues: [{ id: 'r', severity: 'high', blocking: true, title: 't', description: 'd', file: 'a.ts', line: 3 }],
  completionOverride: { reason: 'ok', at: 'T' },
  consecutiveFailures: 1,
  agentProfileId: 'ap_000000000001',
  createdAt: 'T',
  updatedAt: 'T',
  spec_truncated: false
} satisfies Task
const detail = {
  ...task,
  attempts: [{ id: 'dsp_1', provider: 'claude', accountId: 'acc', repair: 'check-failure', outcome: 'failed', startedAt: 'T', agentProfileId: 'ap_000000000001' }],
  openQuestionId: 'gat_1'
} satisfies TaskDetail
const question = { id: 'gat_1', runId: 'run_1', taskId: 'tsk_1', question: 'q', kind: 'convergence-exhausted', status: 'open', createdAt: 'T' } satisfies Question
const answered = { ...question, status: 'resolved', resolution: 'retry-once', retryOnceFailed: 'busy' } satisfies AnsweredQuestion
const completion = {
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
      detail: { taskId: 'tsk_1', checks: [{ configId: 'c', name: 'tests', status: 'failed' }], blockingIssues: [], otherIssueCount: 0, suspiciousFiles: [], policyChanged: false },
      failureSummary: 'tests failed',
      lastFailure: 'x'
    }
  ]
} satisfies RunCompletion
const event = { at: 'T', kind: 'dispatch-started', sourceId: 'dsp_1', taskId: 'tsk_1', summary: 's', provider: 'claude', repair: 'review-failure' } satisfies RunEvent
const endings = [
  { runId: 'run_1', jobId: 'job_1', progress: { done: 1, total: 2 }, state: 'waiting', questionId: 'gat_1', taskId: 'tsk_1' },
  { runId: 'run_1', jobId: 'job_1', progress: { done: 1, total: 2 }, state: 'limited', resetsAt: 'T' },
  { runId: 'run_1', jobId: 'job_1', progress: { done: 2, total: 2 }, state: 'completed' },
  { state: 'timeout', jobId: 'job_1', runId: null, progress: { done: 0, total: 0 } }
] satisfies WaitResult[]
// Agent profiles: a profile as agentProfiles.get answers it
const profile = {
  id: 'ap_000000000001',
  name: 'Reviewer',
  description: 'd',
  status: 'archived',
  accountIds: ['acc'],
  mcpExclude: ['mcp_1'],
  permission: 'bypass',
  createdAt: 'T',
  updatedAt: 'T',
  lastUsedAt: 'T'
} satisfies AgentProfile
const stopped = { runId: 'run_1', stopped: 2, paused: true, coordinatorStopped: true } satisfies StopResult
const listed = { items: [project] } satisfies ListResult<Project>
const withRun = { ...job, run } satisfies JobWithRun
// SDK 1d: an event's payload is the DTO of its type
const runEvent = { id: 'ev_0123456789ab_7', type: 'run.completed', sequence: 7, occurredAt: 'T', jobId: 'job_1', runId: 'run_1', payload: run } satisfies AsteraEvent<'run.completed'>
const repairEvent = {
  id: 'ev_0123456789ab_8',
  type: 'completion.repair_started',
  sequence: 8,
  occurredAt: 'T',
  runId: 'run_1',
  taskId: 'tsk_1',
  payload: completion.tasks[0]
} satisfies AsteraEvent<'completion.repair_started'>
const page = { items: [runEvent, repairEvent], nextCursor: 'ev_0123456789ab_8', gap: false } satisfies EventList
// @ts-expect-error a job.created event carries a Job, not a Run
const wrongPayload: AsteraEvent<'job.created'> = { id: 'ev_0123456789ab_9', type: 'job.created', sequence: 9, occurredAt: 'T', payload: run }

// Plugin Phase 3: the session events (events and notifications design N2)
const session = { id: 's1', kind: 'chat', title: 't', provider: 'codex', cwd: 'D:\p' } satisfies EventSession
const inputEvent = { id: 'ev_0123456789ab_10', type: 'session.input_needed', sequence: 10, occurredAt: 'T', sessionId: 's1', payload: { session, prompt: null } } satisfies AsteraEvent<'session.input_needed'>
const limitEvent = {
  id: 'ev_0123456789ab_11',
  type: 'session.limit_waiting',
  sequence: 11,
  occurredAt: 'T',
  sessionId: 's1',
  payload: { session: { id: 's1', kind: 'terminal' }, scope: 'session', nextRetryAt: 'T' }
} satisfies AsteraEvent<'session.limit_waiting'>
const switchEvent = { id: 'ev_0123456789ab_12', type: 'session.account_switched', sequence: 12, occurredAt: 'T', sessionId: 's1', payload: { session, accountLabel: 'work' } } satisfies AsteraEvent<'session.account_switched'>
const gapHasNoSession = ((g: EventGap) => g.sessionId)({ type: 'gap' }) satisfies undefined
// @ts-expect-error a session event's prompt is permission, question or null
const wrongPrompt: AsteraEvent<'session.input_needed'> = { ...inputEvent, payload: { session, prompt: 'other' } }

describe('the public DTOs', () => {
  it('are types only', () => {
    expect(Object.keys(types)).toEqual([])
  })

  it('take the reference samples', () => {
    expect([project, job, run, task, detail, question, answered, completion, event, endings, stopped, listed, withRun, runEvent, repairEvent, page, wrongPayload, inputEvent, limitEvent, switchEvent, gapHasNoSession, wrongPrompt, profile].length).toBe(23)
  })
})
