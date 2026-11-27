import { describe, it, expect } from 'vitest'
import type { Diagnostic } from '../../../core/problems/diagnostic'
import { CATALOGS, LANGS } from '../../../core/i18n'
import { chipKeyOf, dismissGroups, findingChipKey, findingStateKey, findingWhoKey } from './findingStates'

// Phase 3 Part 1b: how a row says where its finding stands, who changed it, and which Task a dismissal goes to
const row = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  schemaVersion: 1,
  id: 'check:t1:lint:0',
  ref: 'check:t1:0123456789ab',
  source: { kind: 'check', id: 'plugin:lint', label: 'Lint' },
  severity: 'error',
  message: 'x is not defined',
  origin: { runId: 'r1', taskId: 't1', task: 'Auth' },
  ...over
})

describe('finding chips', () => {
  it('names a recorded finding’s state, and nothing for a row without a record', () => {
    expect(findingChipKey(row({ finding: { state: 'repair-requested', history: [] } }))).toBe('problems.finding.repair-requested')
    const asked = { at: 'x', by: 'person' as const, from: null, to: 'repair-requested' as const }
    expect(findingChipKey(row({ finding: { state: 'open', history: [asked, { at: 'y', by: 'astera', from: 'repair-requested', to: 'open' }] } }))).toBe('problems.finding.open')
    expect(findingChipKey(row())).toBeNull()
  })

  // Screen check: a finding dismissed and taken back, never repaired, is just open again; "still there" would say a repair
  // was tried
  it('shows no chip for an open finding that was only dismissed and taken back', () => {
    const history = [
      { at: 'x', by: 'person' as const, from: null, to: 'dismissed' as const, note: 'known' },
      { at: 'y', by: 'person' as const, from: 'dismissed' as const, to: 'open' as const }
    ]
    expect(findingChipKey(row({ finding: { state: 'open', history } }))).toBeNull()
    expect(findingStateKey('resolved-pending-verification')).toBe('problems.finding.resolved-pending-verification')
  })

  // Found on the Part 4 screen check: the diff showed "still there" on a finding no one had acted on
  it('gives a finding’s chip from its state and history alone, the diff’s way, by the same rule', () => {
    expect(chipKeyOf('open', [])).toBeNull()
    expect(chipKeyOf('open', [{ at: 'T', by: 'person', from: 'open', to: 'dismissed' }, { at: 'T', by: 'person', from: 'dismissed', to: 'open' }])).toBeNull()
    expect(chipKeyOf('open', [{ at: 'T', by: 'person', from: 'open', to: 'repair-requested' }, { at: 'T', by: 'astera', from: 'repair-requested', to: 'open' }])).toBe(findingStateKey('open'))
    expect(chipKeyOf('dismissed', [{ at: 'T', by: 'person', from: 'open', to: 'dismissed' }])).toBe(findingStateKey('dismissed'))
  })

  it('names who changed it', () => {
    expect(findingWhoKey('person')).toBe('problems.finding.by.person')
    expect(findingWhoKey('astera')).toBe('problems.finding.by.astera')
  })

  it('has every state’s and every actor’s words in every language', () => {
    const keys = [
      ...(['open', 'repair-requested', 'resolved-pending-verification', 'verified', 'dismissed'] as const).map(findingStateKey),
      ...(['person', 'coordinator', 'astera', 'unknown'] as const).map(findingWhoKey)
    ]
    for (const lang of LANGS) for (const key of keys) expect((CATALOGS[lang].messages as Record<string, string | undefined>)[key], `${lang} ${key}`).toBeTruthy()
  })
})

describe('dismissGroups', () => {
  it('groups the chosen rows by Task with each reference once, and gives null when a row is not a Task’s', () => {
    const other = row({ id: 'check:t2:lint:0', ref: 'check:t2:aaaaaaaaaaaa', origin: { runId: 'r1', taskId: 't2', task: 'B' } })
    const again = row({ id: 'check:t1:lint:1' })
    const review = row({ id: 'review:t1:i1', ref: 'review:t1:bbbbbbbbbbbb' })
    expect(dismissGroups([row(), other, again, review])).toEqual([
      { task: 't1', finding: ['check:t1:0123456789ab', 'review:t1:bbbbbbbbbbbb'] },
      { task: 't2', finding: ['check:t2:aaaaaaaaaaaa'] }
    ])
    expect(dismissGroups([row(), row({ origin: undefined })])).toBeNull()
    expect(dismissGroups([row({ ref: undefined })])).toBeNull()
    expect(dismissGroups([])).toBeNull()
  })
})
