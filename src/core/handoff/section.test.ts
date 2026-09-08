import { describe, it, expect } from 'vitest'
import { handoffSection, HANDOFF_SECTION_CHARS_MAX, HANDOFF_LIST_MAX, HANDOFF_ABSENT_TEXT } from './section'
import type { Handoff } from './types'

const memo: Handoff = {
  version: 1,
  sessionId: 's-1',
  projectPath: 'C:/p/notes',
  provider: 'claude',
  createdAt: '2026-09-08T09:09:41.000Z',
  git: { branch: 'main', head: '11ad41ae28a2af5c93a0c3e36392bf1f1f7b1a5c' },
  objective: 'make the ordering test pass',
  completed: ['ran the suite (5 of 6 pass)'],
  currentProblems: ['list() returns readdir order'],
  nextActions: ['write savedAt in put()', 'sort list() by it'],
  constraints: ['do not sort on the id'],
  decisions: [{ decision: 'store a save time', reason: 'the id format is about to change' }, { decision: 'no new files' }],
  verification: [{ type: 'test', status: 'failed', summary: '1 of 6' }],
  relevantFiles: ['src/store.js']
}

describe('handoffSection', () => {
  it('unknown renders nothing at all — not even a heading', () => {
    expect(handoffSection({ state: 'unknown' }, 'abc')).toBeNull()
  })

  it('none states the absence and what the rest of the briefing is', () => {
    const out = handoffSection({ state: 'none' }, 'abc')!
    expect(out.startsWith('HANDOFF MEMO\n')).toBe(true)
    expect(out).toContain(HANDOFF_ABSENT_TEXT)
    expect(out).toContain('None was left for this session. Everything above is what the app could observe.')
  })

  it('a found memo carries the heading, the hint line, every non-empty block and the time and head', () => {
    const out = handoffSection({ state: 'found', memo }, memo.git!.head)!
    expect(out).toContain("HANDOFF MEMO (the previous agent's own account, written 2026-09-08T09:09:41.000Z at HEAD 11ad41a)")
    expect(out.split('\n')[1]).toBe('This is a hint; the working tree is the truth.')
    expect(out).toContain('Objective: make the ordering test pass')
    expect(out).toContain('Completed:\n- ran the suite (5 of 6 pass)')
    expect(out).toContain('Current problems:\n- list() returns readdir order')
    expect(out).toContain('Next actions:\n- write savedAt in put()\n- sort list() by it')
    expect(out).toContain('Constraints the person stated:\n- do not sort on the id')
    expect(out).toContain('Decisions:\n- store a save time: the id format is about to change\n- no new files')
    expect(out).toContain('Verification the agent reports:\n- test: failed (1 of 6)')
    expect(out).toContain('Files that matter next:\n- src/store.js')
  })

  it('an empty block is omitted, heading included', () => {
    const out = handoffSection({ state: 'found', memo: { ...memo, completed: [], relevantFiles: [] } }, memo.git!.head)!
    expect(out).not.toContain('Completed:')
    expect(out).not.toContain('Files that matter next:')
    expect(out).toContain('Next actions:')
  })

  it('no objective, no Objective line', () => {
    const { objective: _o, ...rest } = memo
    const out = handoffSection({ state: 'found', memo: rest as Handoff }, memo.git!.head)!
    expect(out).not.toContain('Objective:')
  })

  it('says the tree moved only when both heads are known and differ', () => {
    const same = handoffSection({ state: 'found', memo }, memo.git!.head)!
    expect(same).not.toContain('The tree has moved since')
    const moved = handoffSection({ state: 'found', memo }, '96c91a2000000000000000000000000000000000')!
    expect(moved).toContain('The tree has moved since: HEAD was 11ad41a, it is now 96c91a2. Inspect the diff before trusting the memo.')
    const noCurrent = handoffSection({ state: 'found', memo }, null)!
    expect(noCurrent).not.toContain('The tree has moved since')
    const noMemoHead = handoffSection({ state: 'found', memo: { ...memo, git: null } }, 'abc')!
    expect(noMemoHead).not.toContain('The tree has moved since')
    expect(noMemoHead).toContain('written 2026-09-08T09:09:41.000Z)') // no "at HEAD" when unknown
  })

  it('the re-check sentence appears only when the memo claims something passed', () => {
    const failed = handoffSection({ state: 'found', memo }, null)!
    expect(failed).not.toContain('has not been re-checked')
    const passed = handoffSection(
      { state: 'found', memo: { ...memo, verification: [{ type: 'test', status: 'passed' }] } },
      null
    )!
    expect(passed).toContain('The verification above has not been re-checked by the app. Run it again before relying on it.')
  })

  it('caps every list at HANDOFF_LIST_MAX and says how many it left out', () => {
    const many = Array.from({ length: 14 }, (_, i) => `step ${i}`)
    const out = handoffSection({ state: 'found', memo: { ...memo, nextActions: many } }, null)!
    expect(out).toContain('- step 9')
    expect(out).not.toContain('- step 10')
    expect(out).toContain('- …and 4 more')
    expect(HANDOFF_LIST_MAX).toBe(10)
  })

  it('keeps the closing sentences when the section is over budget', () => {
    const bloated = {
      ...memo,
      completed: Array.from({ length: 10 }, () => 'y'.repeat(300)),
      verification: [{ type: 'test' as const, status: 'passed' as const }]
    }
    const out = handoffSection({ state: 'found', memo: bloated }, 'ffffffff00000000000000000000000000000000')!
    expect(out.length).toBeLessThanOrEqual(HANDOFF_SECTION_CHARS_MAX)
    expect(out).toContain('[This memo was cut to fit its size budget.]')
    expect(out).toContain('The tree has moved since')
    expect(out).toContain('has not been re-checked')
    expect(out.startsWith('HANDOFF MEMO (')).toBe(true)
  })

  it('same input, same string', () => {
    const a = handoffSection({ state: 'found', memo }, 'abc')
    const b = handoffSection({ state: 'found', memo }, 'abc')
    expect(a).toBe(b)
  })

  it('holds the cap even when the fixed parts alone would exceed it', () => {
    const absurd = { ...memo, createdAt: 'T'.repeat(3000), verification: [{ type: 'test' as const, status: 'passed' as const }] }
    const out = handoffSection({ state: 'found', memo: absurd }, 'ffffffff00000000000000000000000000000000')!
    expect(out.length).toBeLessThanOrEqual(HANDOFF_SECTION_CHARS_MAX)
    expect(out.startsWith('HANDOFF MEMO (')).toBe(true)
  })
})
