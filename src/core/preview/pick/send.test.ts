import { describe, it, expect } from 'vitest'
import { looksLikeChoicePrompt } from '../../rolling/detect'
import { isWaitingOnDialog, POST_PASTE_SUBMIT_DELAY_MS } from './send'

// Every screen below was captured from a real session during the Design Mode dev-app run, not written
// from memory. The two trust dialogs are the ones that ate a batch each.
const CLAUDE_TRUST = [
  ' Accessing workspace:',
  '',
  ' C:\Users\me\scratch\preview-demo',
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
].join('\n')

const CODEX_TRUST = [
  '> You are in C:\Users\me\scratch\preview-demo',
  '  Do you trust the contents of this directory? Working with untrusted contents comes with higher',
  '  risk of prompt injection.',
  '› 1. Yes, continue',
  '  2. No, quit',
  '  Press enter to continue'
].join('\n')

const CLAUDE_PERMISSION = [
  ' Read outside the working directories',
  '  Read(C:\Users\me\AppData\Roaming\astera-dev\preview\shots\a.png)',
  ' Allow reads outside the working directories?',
  ' ❯ 1. Yes, keep allowing reads outside the working directories',
  '   2. No, block reads outside the working directories from now on',
  '   3. No, ask again next time',
  ' Esc to cancel · Tab to amend'
].join('\n')

const CLAUDE_IDLE = [
  '────────────────────────────────',
  '❯ ',
  '────────────────────────────────',
  '  ⚠ Transcript saving is off',
  '  ⏵⏵ auto mode on (shift+tab to cycle)'
].join('\n')

const CLAUDE_HOLDING_A_PASTE = [
  '────────────────────────────────',
  '❯ [Pasted text #1 +114 lines]',
  '────────────────────────────────',
  '  paste again to expand'
].join('\n')

const CODEX_IDLE = [
  '› Ask Codex to do anything',
  '  gpt-5.6-sol xhigh · ~\scratch\preview-demo'
].join('\n')

const CODEX_HOLDING_A_PASTE = [
  '› [Pasted Content 1930 chars]',
  '  gpt-5.6-sol xhigh · ~\scratch\preview-demo'
].join('\n')

const AGENT_WORKING = [
  '● Reading src/core/preview/pick/send.ts',
  '✻ Pontificating… (12s · esc to interrupt)'
].join('\n')

describe('isWaitingOnDialog', () => {
  it('catches the two dialogs that each swallowed a batch', () => {
    expect(isWaitingOnDialog(CLAUDE_TRUST)).toBe(true)
    expect(isWaitingOnDialog(CODEX_TRUST)).toBe(true)
  })

  it('catches a permission prompt, which is the same mistake with a worse answer', () => {
    expect(isWaitingOnDialog(CLAUDE_PERMISSION)).toBe(true)
  })

  it('lets a session at its prompt through, empty or already holding a paste', () => {
    expect(isWaitingOnDialog(CLAUDE_IDLE)).toBe(false)
    expect(isWaitingOnDialog(CLAUDE_HOLDING_A_PASTE)).toBe(false)
    expect(isWaitingOnDialog(CODEX_IDLE)).toBe(false)
    expect(isWaitingOnDialog(CODEX_HOLDING_A_PASTE)).toBe(false)
  })

  it('does not mistake a working agent for a dialog — "esc to interrupt" is not a footer', () => {
    expect(isWaitingOnDialog(AGENT_WORKING)).toBe(false)
  })

  it('an empty screen is not a dialog', () => {
    expect(isWaitingOnDialog('')).toBe(false)
  })

  it('reads through the colour a TUI paints its cursor with', () => {
    expect(isWaitingOnDialog('\u001b[36m›\u001b[0m 1. Yes, continue')).toBe(true)
  })
})

describe('POST_PASTE_SUBMIT_DELAY_MS', () => {
  it('is long enough to be a gap and short enough not to be a wait', () => {
    expect(POST_PASTE_SUBMIT_DELAY_MS).toBeGreaterThan(0)
    expect(POST_PASTE_SUBMIT_DELAY_MS).toBeLessThan(500)
  })
})

describe('what the existing detector alone does not cover', () => {
  // The reason this module exists rather than calling looksLikeChoicePrompt directly. If Codex ever
  // switches to ❯, or the shared detector learns ›, this test goes red and the extra rule can go.
  it('Claude Code’s dialog is already caught by the shared detector; Codex’s is not', () => {
    expect(looksLikeChoicePrompt(CLAUDE_TRUST)).toBe(true)
    expect(looksLikeChoicePrompt(CODEX_TRUST)).toBe(false)
    expect(isWaitingOnDialog(CODEX_TRUST)).toBe(true)
  })
})
