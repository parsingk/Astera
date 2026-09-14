import { describe, it, expect } from 'vitest'
import { queuedMessagesOf } from './queuedMessages'

// A real Claude screen with a message waiting its turn (measured 2026-09-12): `QA` was sent first and
// is running, `QB` was sent while it ran and is queued. Note what tells them apart — `QA` starts at
// the margin, `QB` is indented.
const queuedScreen = [
  '  500',
  '  1부터 500까지 다 셌습니다.',
  '✻ Baked for 16s · done 오후 7:44',
  '❯ QA',
  '✶ Drizzling… (4s · thinking with xhigh effort)',
  '  ⎿  Tip: Send messages to Claude while it works to steer Claude',
  '  ❯ QB',
  '──────────────────────────────',
  '❯ Press up to edit queued messages',
  '──────────────────────────────',
  '  [Opus 5 (1M context)] │ q2probe',
  '  Context ░░░░░░ 6%'
]

// The same session with nothing waiting (measured).
const idleScreen = [
  '● 1, 2, 3',
  '✻ Brewed for 2s · done 오후 7:33',
  '──────────────────────────────',
  '❯',
  '──────────────────────────────',
  '  [Opus 5 (1M context)] │ qprobe'
]

describe('queuedMessagesOf', () => {
  it('reads a message waiting its turn', () => {
    expect(queuedMessagesOf(queuedScreen)).toEqual(['QB'])
  })

  // The one that makes the rule work: a turn that already ran carries the same marker at the margin.
  it('does not mistake a turn that already ran for one waiting', () => {
    expect(queuedMessagesOf(queuedScreen)).not.toContain('QA')
  })

  it('reads several, in the order they will run', () => {
    const two = [...queuedScreen]
    two.splice(7, 0, '  ❯ QC')
    expect(queuedMessagesOf(two)).toEqual(['QB', 'QC'])
  })

  it('answers nothing when nothing is waiting', () => {
    expect(queuedMessagesOf(idleScreen)).toEqual([])
    expect(queuedMessagesOf([])).toEqual([])
  })

  // codex draws no box around its composer, so the anchor is absent and this says nothing rather
  // than guessing at a shape nobody has measured.
  it('says nothing for a screen with no composer box', () => {
    expect(queuedMessagesOf(['› Ask Codex to do anything', '  gpt-5.6-sol xhigh · D:\\x'])).toEqual([])
  })
})
