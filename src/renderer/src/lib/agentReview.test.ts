import { describe, it, expect } from 'vitest'
import { t as translate, type MessageKey, type MessageParams } from '../../../core/i18n'
import type { Dispatch } from '../../../core/orchestration/types'
import type { FileAttribution } from '../../../core/review/types'
import { attemptLabel, attributionBadge, attributionTitle, findingsByLine, rangeLabel, shortSha } from './agentReview'
import type { DiffFinding } from '../../../core/review/types'

// Phase 3 Part 4: the words of the changed-files block's attempt selector, named range and attribution badges
const en = (key: MessageKey, params?: MessageParams): string => translate('en', key, params)
const dispatch = (over: Partial<Dispatch>): Dispatch => ({ id: 'd1', taskId: 't1', provider: 'claude', accountId: 'claude-a', sessionId: 's1', cwd: 'F:\\p', specPath: '', startedAt: '2026-11-27T10:02:00.000Z', workerState: 'stopped', retained: false, ...over }) as Dispatch
const evidence = { dispatchId: 'd1', taskId: 't1', provider: 'claude' as const, accountId: 'claude-a', sessionId: 'sess-123456789', cwd: 'F:\\p', base: 'aaaaaaa1111', head: 'bbbbbbb2222' }

describe('agentReview words', () => {
  it('shortens a commit to seven characters', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456')
    expect(shortSha(null)).toBe('')
  })

  it('labels an attempt by its number, provider and time, and marks a repair and a retry', () => {
    const plain = attemptLabel(en, dispatch({}), 1)
    expect(plain).toContain('1')
    expect(plain).toContain('Claude')
    expect(attemptLabel(en, dispatch({ provider: 'codex', repair: 'review-failure' }), 2)).toContain(en('agentReview.attempt.repair'))
    expect(attemptLabel(en, dispatch({ retryOf: 'd0' }), 3)).toContain(en('agentReview.attempt.retry'))
  })

  it('names a recorded range and a range up to the working tree', () => {
    expect(rangeLabel(en, { base: 'aaaaaaa1111', head: 'bbbbbbb2222' })).toBe(en('agentReview.range', { base: 'aaaaaaa', head: 'bbbbbbb' }))
    expect(rangeLabel(en, { base: 'aaaaaaa1111', head: null })).toBe(en('agentReview.range.live', { base: 'aaaaaaa' }))
  })

  it('badges agent with its provider, mixed and unknown, and nothing without an attribution', () => {
    expect(attributionBadge(en, { kind: 'agent', level: 'recorded-range', evidence: [evidence] })).toEqual({ text: en('agentReview.attr.agent', { provider: 'Claude' }), tone: 'agent' })
    const two: FileAttribution = { kind: 'agent', level: 'recorded-range', evidence: [evidence, { ...evidence, dispatchId: 'd2', provider: 'codex' }] }
    expect(attributionBadge(en, two)?.text).toBe(en('agentReview.attr.agent', { provider: 'Claude, Codex' }))
    expect(attributionBadge(en, { kind: 'mixed', why: 'overlap', evidence: [evidence] })).toEqual({ text: en('agentReview.attr.mixed'), tone: 'mixed' })
    expect(attributionBadge(en, { kind: 'unknown', why: 'no-range', evidence: [] })).toEqual({ text: en('agentReview.attr.unknown'), tone: 'unknown' })
    expect(attributionBadge(en, undefined)).toBeNull()
  })

  it('titles a badge with each attempt’s evidence, its level or why, and the limit', () => {
    const agent = attributionTitle(en, { kind: 'agent', level: 'observe-audit', evidence: [evidence] })
    expect(agent).toContain('claude-a')
    expect(agent).toContain('sess-123456789')
    expect(agent).toContain(en('agentReview.range', { base: 'aaaaaaa', head: 'bbbbbbb' }))
    expect(agent).toContain(en('agentReview.level.observe-audit'))
    expect(agent).toContain(en('agentReview.limit'))
    expect(attributionTitle(en, { kind: 'unknown', why: 'shared-folder-live', evidence: [] })).toContain(en('agentReview.why.shared-folder-live'))
    expect(attributionTitle(en, { kind: 'mixed', why: 'overlap', evidence: [evidence] })).toContain(en('agentReview.why.overlap'))
  })
})

describe('findingsByLine', () => {
  const f = (ref: string, placement: DiffFinding['placement']): DiffFinding => ({ ref, taskId: 't1', title: ref, text: ref, severity: 'high', state: 'open', history: [], placement })
  it('groups findings by their line, other revision and file, in order', () => {
    const got = findingsByLine([f('a', { line: 3 }), f('b', 'other-revision'), f('c', { line: 3 }), f('d', 'file'), f('e', { line: 9 })])
    expect([...got.inline.entries()].map(([line, xs]) => [line, xs.map((x) => x.ref)])).toEqual([
      [3, ['a', 'c']],
      [9, ['e']]
    ])
    expect(got.otherRevision.map((x) => x.ref)).toEqual(['b'])
    expect(got.file.map((x) => x.ref)).toEqual(['d'])
  })
})
