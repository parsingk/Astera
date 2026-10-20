// Which of the app's orchestration commands need the Host's GitHub (GitHub lifecycle G7a): main's copy of the command
// layer has no gh and no origin, so these answered 409 from the app while the same command through the Host works.
import { describe, it, expect } from 'vitest'
import { needsHostGitHub } from './hostGitHub'
import type { OrchState } from './state'
import type { Gate } from './types'

const gate = (id: string, kind: Gate['kind']): Gate => ({ id, kind, status: 'open' }) as unknown as Gate
const state = { gates: [gate('g_gh', 'github-ci-outside'), gate('g_cv', 'convergence-exhausted')] } as unknown as OrchState

describe('needsHostGitHub', () => {
  it('a Job made with the lifecycle on goes to the Host; one without it stays here', () => {
    expect(needsHostGitHub(state, 'run-create', { githubLifecycle: true })).toBe(true)
    expect(needsHostGitHub(state, 'jobs-create', { githubLifecycle: true })).toBe(true)
    expect(needsHostGitHub(state, 'run-create', {})).toBe(false)
    expect(needsHostGitHub(state, 'run-create', { githubLifecycle: 'yes' })).toBe(false)
  })

  // continue fast-forwards the Run root from GitHub and rerun reruns its CI: only the Host can, and the answers the
  // app sent answered 409
  it('an answer to a GitHub question goes to the Host; an answer to any other question stays here', () => {
    expect(needsHostGitHub(state, 'gate-resolve', { id: 'g_gh', resolution: 'continue' })).toBe(true)
    expect(needsHostGitHub(state, 'questions-answer', { id: 'g_gh', answer: 'rerun' })).toBe(true)
    expect(needsHostGitHub(state, 'gate-resolve', { id: 'g_cv', resolution: 'retry' })).toBe(false)
    expect(needsHostGitHub(state, 'gate-resolve', { id: 'g_none', resolution: 'retry' })).toBe(false)
  })

  it('reconverge and the preflight go to the Host; everything else stays here', () => {
    expect(needsHostGitHub(state, 'runs-reconverge', { id: 'run_1' })).toBe(true)
    expect(needsHostGitHub(state, 'github-preflight', { cwd: 'D:/p' })).toBe(true)
    expect(needsHostGitHub(state, 'task-update', { id: 't_1' })).toBe(false)
  })
})
