import { describe, it, expect } from 'vitest'
import { promptLinesOf } from './promptLines'

// A real Claude approval screen, as its terminal drew it (measured 2026-09-12). Note where the dialog
// sits: at the bottom, with no input line under it, and with its highlighted choice carrying the very
// marker an input line would.
const approvalScreen = [
  '● Write(hc-show.txt)',
  '',
  '────────────────────────────',
  ' Create file',
  ' hc-show.txt',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  '  1 ok',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  ' Do you want to create hc-show.txt?',
  ' ❯ 1. Yes',
  '   2. Yes, and switch to accept edits',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend'
]

// Claude Code's trust prompt for a folder it has not seen, as it drew it (measured 2026-09-12). The
// reason this fixture exists: its choices carry NO number, so the highlighted one is `❯ No, exit` —
// indistinguishable from an input line by anything after the marker.
const trustScreen = [
  '',
  '──────────────────────────────────────────────',
  ' Accessing workspace:',
  '',
  ' C:\Users\anipen\AppData\Local\Temp\scratchpad\trustprobe',
  '',
  ' Quick safety check: Is this a project you created or one you trust?',
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel'
]

// The same session a moment later: answered, back at its prompt, status bar drawn (measured).
const idleScreen = [
  '● 파일을 썼습니다.',
  '',
  '✻ Brewed for 11s · done 오전 7:43',
  '',
  '────────────────────────────',
  '❯',
  '────────────────────────────',
  '  [Opus 5 (1M context)] │ astera git:(develop*) │ ⏱️  12h 24m',
  '  Context █░░░░░░░░░ 7% │ Usage ⚠ Limit reached',
  '  ⏸ manual mode on · ← 4 agents'
]

// Codex at its prompt (measured 2026-09-12). It boxes nothing: the composer is the last line, with the
// turn above it and no rule between them, and `@` is what had been typed into it.
const codexScreen = [
  '╰─────────────────────────────────╯',
  '  Tip: This is GPT-6, a new generation of intelligence.',
  '⚠ 2 MCP startup issues · ctrl + t for details',
  '• You have 2 usage limit resets available. Run /usage to use one.',
  '› @',
  '■ Conversation interrupted - tell the model what to do differently.',
  '› @'
]

// codex's own trust prompt for a new folder (measured 2026-09-12). It marks its highlighted choice
// with `›` — the very character its input line starts with — which an earlier version of this did not
// expect, and would have cut the whole dialog away at.
const codexTrustScreen = [
  '> You are in C:' + String.fromCharCode(92) + 'Temp' + String.fromCharCode(92) + 'scratchpad' + String.fromCharCode(92) + 'codexprobe',
  '  Do you trust the contents of this directory?',
  '› 1. Yes, continue',
  '  2. No, quit',
  '  Press enter to continue'
]

describe('promptLinesOf', () => {
  it('keeps the question and every one of its options', () => {
    const kept = promptLinesOf(approvalScreen, 16)
    expect(kept).toContain(' Do you want to create hc-show.txt?')
    expect(kept).toContain(' ❯ 1. Yes')
    expect(kept).toContain('   2. Yes, and switch to accept edits')
    expect(kept).toContain('   3. No')
    expect(kept).toContain(' Esc to cancel · Tab to amend')
  })

  // The highlighted choice carries `❯`. Cutting at it — which an earlier version did — threw away
  // every option below, leaving a question nobody could answer.
  it('does not mistake the highlighted choice for the input line', () => {
    expect(promptLinesOf(approvalScreen, 16).length).toBeGreaterThan(4)
  })

  // The one that broke the digit rule this replaced: an unnumbered choice. Nothing after the marker
  // tells `❯ No, exit` from an input line — only the absence of a rule above it does.
  it('keeps an unnumbered choice, which no reading of the text could rescue', () => {
    const kept = promptLinesOf(trustScreen, 16)
    expect(kept).toContain(' ❯ No, exit')
    expect(kept).toContain('   Yes, I trust this folder')
    expect(kept).toContain(' Enter to confirm · Esc to cancel')
    expect(kept).toContain(' Security guide')
  })

  // The status bar is the loudest thing on screen and says nothing about the question; the input line
  // is where the answer goes, not part of what was asked.
  it('drops the boxed input line and the status bar under it', () => {
    const kept = promptLinesOf(idleScreen, 16)
    expect(kept.some((l) => l.includes('Context'))).toBe(false)
    expect(kept.some((l) => l.includes('manual mode'))).toBe(false)
    expect(kept.some((l) => l.trim() === '❯')).toBe(false)
    expect(kept).toContain('● 파일을 썼습니다.')
  })

  // Codex draws no rule around its composer, so the box test cannot apply to it — and does not need
  // to: its choices are numbered rows that never carry `›`.
  it('cuts codex at its last prompt marker, box or no box', () => {
    const kept = promptLinesOf(codexScreen, 16)
    expect(kept[kept.length - 1]).toBe(
      '■ Conversation interrupted - tell the model what to do differently.'
    )
    // One `› @` survives: codex echoes a past input with the same marker, and that echo is
    // transcript, not the line waiting for an answer.
    expect(kept.filter((l) => l.trim() === '› @')).toHaveLength(1)
  })

  // Same trap as Claude's, one character apart: codex marks its highlighted choice with the character
  // its input line starts with too.
  it('keeps codex a dialog whose choice carries its prompt marker', () => {
    const kept = promptLinesOf(codexTrustScreen, 16)
    expect(kept).toContain('› 1. Yes, continue')
    expect(kept).toContain('  2. No, quit')
    expect(kept).toContain('  Press enter to continue')
  })

  it('keeps the end of a long screen rather than its beginning', () => {
    expect(promptLinesOf(approvalScreen, 3)).toEqual([
      '   3. No',
      '', // the dialog's own blank line: one is kept, a run of them is not
      ' Esc to cancel · Tab to amend'
    ])
  })

  it('collapses the padding a TUI draws, so a quote is not mostly blank', () => {
    expect(promptLinesOf(['a', '', '', '', 'b', '────', '❯'], 16)).toEqual(['a', '', 'b'])
  })

  it('answers nothing for an empty screen', () => {
    expect(promptLinesOf([], 16)).toEqual([])
    expect(promptLinesOf(['   ', ''], 16)).toEqual([])
  })
})
