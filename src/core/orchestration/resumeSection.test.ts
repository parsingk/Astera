import { describe, it, expect } from 'vitest'
import { formatResumeSection, MAX_PACKET_CHARS } from './resumeSection'
import type { Checkpoint } from './checkpoint'

const base: Checkpoint = {
  version: 1,
  createdAt: '2026-08-26T00:00:00.000Z',
  runId: 'run_1',
  objective: 'Implement OAuth login',
  taskId: 'tsk_1',
  taskTitle: 'Implement Google OAuth callback',
  taskSpec: 'Implement the callback handler and its tests.',
  dependencies: [{ id: 'tsk_0', title: 'Add OAuth provider config', status: 'completed' }],
  dispatchId: 'dsp_2',
  workerState: 'failed',
  limitResetsAt: '2026-08-26T06:00:00.000Z',
  filesModified: ['src/auth/AuthService.ts', 'src/auth/GoogleOAuthProvider.ts'],
  reports: [
    {
      subject: 'callback handler in progress',
      body: 'Implemented the redirect handler. Token refresh is still failing.'
    }
  ],
  validation: { configId: 'test', summary: 'exitCode=1. 125 passed, 2 failed.' },
  decisions: [
    { question: 'Which token store?', status: 'resolved', resolution: 'Use the existing KeyStore.' }
  ],
  git: {
    branch: 'main',
    head: 'def456',
    changed: ['src/auth/AuthService.ts', 'src/auth/GoogleOAuthProvider.ts', 'tests/auth.test.ts'],
    diffstat: '3 files changed, 42 insertions(+), 5 deletions(-)'
  },
  worktreeMoved: true
}

describe('formatResumeSection', () => {
  it('formats the same checkpoint to the same string every time', () => {
    expect(formatResumeSection(base)).toBe(formatResumeSection(base))
  })

  it('never contains the literal strings undefined or null', () => {
    const minimal: Checkpoint = {
      ...base,
      dependencies: [],
      reports: [],
      decisions: [],
      validation: undefined,
      limitResetsAt: undefined,
      git: null,
      worktreeMoved: null
    }
    const out = formatResumeSection(minimal)
    expect(out).not.toContain('undefined')
    expect(out).not.toContain('null')
  })

  it('includes the four required instructions', () => {
    const out = formatResumeSection(base)
    expect(out.toLowerCase()).toContain('start the task from scratch')
    expect(out.toLowerCase()).toContain('inspect the current git diff before editing')
    expect(out).toContain('Preserve the existing worktree and unfinished changes')
    expect(out).toContain('astera send --type worker_done')
    expect(out).toContain(`--task-id ${base.taskId}`)
    expect(out).toContain(`--dispatch-id ${base.dispatchId}`)
  })

  it('never leaks a diff body, only a diffstat', () => {
    const out = formatResumeSection(base)
    expect(out).toContain(base.git!.diffstat!)
    expect(out).not.toContain('@@')
    expect(out).not.toContain('+++')
  })

  it('cuts the previous-worker-report tail first when over the size cap', () => {
    const bigReports = Array.from({ length: 30 }, (_, i) => ({
      subject: `report-${i}`,
      body: 'x'.repeat(400)
    }))
    const big: Checkpoint = { ...base, reports: bigReports }
    const out = formatResumeSection(big)
    expect(out.length).toBeLessThanOrEqual(MAX_PACKET_CHARS)
    // The oldest report is cut first — it must not survive the trim.
    expect(out).not.toContain('report-0')
    // Structured sections are never sacrificed to make room.
    expect(out).toContain(base.objective)
    expect(out).toContain(base.taskTitle)
    expect(out).toContain('src/auth/AuthService.ts')
    // Trimming itself must stay deterministic.
    expect(formatResumeSection(big)).toBe(out)
  })
})
