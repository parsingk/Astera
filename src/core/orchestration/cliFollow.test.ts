// `runs follow` (CLI spec §22): one line per timeline event. The lines have no contract, like every
// `--human` shape; what is pinned here is that each kind of event says what happened and to which task.
import { describe, it, expect } from 'vitest'
import { eventKey, followLine, clockOf } from './cliFollow'
import type { JobEvent } from '../types'

const AT = '2026-09-26T05:21:02.000Z'
const ev = (over: Partial<JobEvent>): JobEvent => ({ at: AT, kind: 'message', sourceId: 'x', summary: '', ...over })

describe('clockOf', () => {
  it('is the local wall clock, hours, minutes and seconds', () => {
    const d = new Date(AT)
    const two = (n: number): string => String(n).padStart(2, '0')
    expect(clockOf(AT)).toBe(`${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`)
  })

  it('an unreadable time is left as it came rather than NaN', () => {
    expect(clockOf('not a time')).toBe('not a time')
  })
})

describe('followLine', () => {
  const line = (over: Partial<JobEvent>): string => followLine(ev(over)).replace(/^\[[^\]]*\] /, '')

  it('starts with the time in brackets', () => {
    expect(followLine(ev({ kind: 'run-created', summary: 'o' }))).toBe(`[${clockOf(AT)}] run created: o`)
  })

  it('says which task, for each kind', () => {
    expect(line({ kind: 'task-created', taskId: 'task_1', summary: 'Fix the build' })).toBe('task created: task_1 Fix the build')
    expect(line({ kind: 'dispatch-started', taskId: 'task_1', provider: 'codex' })).toBe('worker started: task_1')
    expect(line({ kind: 'dispatch-started', taskId: 'task_1', retry: true })).toBe('worker started: task_1 (retry)')
    expect(line({ kind: 'dispatch-started', taskId: 'task_1', review: true })).toBe('reviewer started: task_1')
    expect(line({ kind: 'dispatch-started', taskId: 'task_1', repair: 'check-failure' })).toBe(
      'repair worker started: task_1 (check-failure)'
    )
    expect(line({ kind: 'limit-hit', taskId: 'task_1' })).toBe('usage limit hit: task_1')
    expect(line({ kind: 'resumed', taskId: 'task_1' })).toBe('worker resumed: task_1')
    expect(line({ kind: 'gate-opened', taskId: 'task_1', summary: 'which DB?' })).toBe('question opened: task_1: which DB?')
    expect(line({ kind: 'gate-resolved', taskId: 'task_1', summary: 'the old one' })).toBe(
      'question answered: task_1: the old one'
    )
  })

  // G7b: a GitHub lifecycle Run's steps, each in words, the commit, check or pull request after it
  it('says each GitHub step', () => {
    expect(line({ kind: 'github-pr-created', summary: '#12' })).toBe('pull request opened: #12')
    expect(line({ kind: 'github-pr-bound', summary: '#12' })).toBe('pull request bound: #12')
    expect(line({ kind: 'github-pushed', summary: 'aaaaaaa' })).toBe('pushed: aaaaaaa')
    expect(line({ kind: 'github-ci-started', summary: 'aaaaaaa' })).toBe('GitHub CI started: aaaaaaa')
    expect(line({ kind: 'github-ci-failed', summary: 'build' })).toBe('GitHub CI failed: build')
    expect(line({ kind: 'github-ci-rerun', summary: 'build' })).toBe('GitHub CI rerun: build')
    expect(line({ kind: 'github-ci-passed', summary: 'aaaaaaa' })).toBe('GitHub CI passed: aaaaaaa')
    expect(line({ kind: 'github-merge-ready', summary: '#12' })).toBe('merge-ready: #12')
    // Final review M5: withheld by the verdict or withdrawn since, it is not merge-ready
    expect(line({ kind: 'github-invalidated', summary: 'head-changed' })).toBe('not merge-ready: head-changed')
    expect(line({ kind: 'github-source-changed', summary: '' })).toBe('source issue changed')
  })

  it('a message is its subject, with the task after it', () => {
    expect(line({ messageType: 'status', summary: 'validation failed', taskId: 'task_1' })).toBe('validation failed (task_1)')
    expect(line({ messageType: 'status', summary: 'coordinator note' })).toBe('coordinator note')
    expect(line({ messageType: 'worker_done', taskId: 'task_1', outcome: 'succeeded', summary: 'done' })).toBe(
      'worker done: task_1 (succeeded): done'
    )
  })

  it('stays on one line whatever the summary holds', () => {
    expect(line({ messageType: 'status', summary: 'a\nb' })).toBe('a b')
  })
})

describe('eventKey', () => {
  // sourceId is unique within a kind only (JobEvent.sourceId): a Gate opens and resolves under one id.
  it('tells apart two kinds with one source', () => {
    expect(eventKey(ev({ kind: 'gate-opened', sourceId: 'g1' }))).not.toBe(eventKey(ev({ kind: 'gate-resolved', sourceId: 'g1' })))
  })
})
