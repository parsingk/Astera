import { describe, it, expect } from 'vitest'
import { formatResumeNote, formatResumeSection, MAX_PACKET_CHARS } from './resumeSection'
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

  // fix round 2: the one section whose job is to say why this session is here used to say "no
  // recorded stop yet" on the very path this feature exists for — a rolled Dispatch is never closed,
  // so workerState stays 'ready' and limitResetsAt is never written. The stop snapshot answers it.
  it('states why the previous worker stopped from the stop snapshot', () => {
    const waited: Checkpoint = {
      ...base,
      workerState: 'ready',
      limitResetsAt: undefined,
      stop: { reason: 'waiting', resetsAt: '2026-08-26T06:00:00.000Z' }
    }
    const out = formatResumeSection(waited)
    expect(out).toContain('stopped on a usage limit')
    expect(out).toContain('2026-08-26T06:00:00.000Z')
    expect(out).not.toContain('no recorded stop yet')
  })

  it('says an account switch happened when that is what the snapshot recorded', () => {
    const switched: Checkpoint = {
      ...base,
      workerState: 'ready',
      limitResetsAt: undefined,
      stop: { reason: 'switching' }
    }
    const out = formatResumeSection(switched)
    expect(out).toContain('moved it to another account')
    expect(out).not.toContain('no recorded stop yet')
  })

  it('falls back to workerState when no stop was recorded', () => {
    const none: Checkpoint = {
      ...base,
      workerState: 'ready',
      limitResetsAt: undefined,
      stop: undefined
    }
    expect(formatResumeSection(none)).toContain('no recorded stop yet')
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

// fix round 2 — SPEC §11.5: `--resume` 을 부르지 않는 재개 경로는 살아 있는 세션이고, 떨어뜨린 것이
// 없으니 인계할 것도 없다. 그 자리에는 전체 Packet 이 아니라 "기다리는 동안 바뀐 것" 한 줄만 간다.
describe('formatResumeNote', () => {
  it('says the worktree moved, lists the changed files, and stays one line', () => {
    const out = formatResumeNote(base)!
    expect(out).toContain('the worktree moved to def456')
    expect(out).toContain('src/auth/AuthService.ts')
    expect(out).toContain('Check the current git diff before editing.')
    expect(out).not.toContain('\n')
  })

  it('does not carry the full packet — no scratch warning, no task spec, no dependencies', () => {
    const out = formatResumeNote(base)!
    expect(out).not.toContain('start the task from scratch')
    expect(out).not.toContain(base.taskSpec)
    expect(out).not.toContain(base.dependencies[0].title)
    expect(out).not.toContain('BEFORE EDITING')
    expect(out).not.toContain('astera send')
  })

  it('is null when git could not be read — nothing was verified, so nothing is claimed', () => {
    expect(formatResumeNote({ ...base, git: null, worktreeMoved: null })).toBeNull()
  })

  it('says nothing about the worktree when there is no baseline to compare against', () => {
    const out = formatResumeNote({ ...base, worktreeMoved: null })!
    expect(out).not.toContain('the worktree')
  })

  it('reports a clean worktree as such', () => {
    const out = formatResumeNote({
      ...base,
      worktreeMoved: false,
      git: { branch: 'main', head: 'def456', changed: [], diffstat: null }
    })!
    expect(out).toContain('did not move')
    expect(out).toContain('no uncommitted changes')
  })

  it('caps a long changed-file list and reports the remainder as a count', () => {
    const changed = Array.from({ length: 45 }, (_, i) => `src/f${i}.ts`)
    const out = formatResumeNote({
      ...base,
      filesModified: [],
      git: { branch: 'main', head: 'def456', changed, diffstat: null }
    })!
    expect(out).toContain('src/f0.ts')
    expect(out).not.toContain('src/f20.ts')
    expect(out).toContain('and 25 more')
    expect(out).not.toContain('\n')
  })
})
