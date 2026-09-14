import { describe, it, expect } from 'vitest'
import { cliBusyOf } from './cliBusy'

// Every line here was captured off a real terminal (2026-09-14), one frame at a time through a whole
// turn — the glyph cycles, the parenthetical changes, and the ellipsis is the one thing that stays.
describe('cliBusyOf', () => {
  const working = [
    '✽ Herding…',
    '· Herding…',
    '✽ Herding… (2s · thinking with xhigh effort)',
    '✢ Herding… (3s · thinking with xhigh effort)',
    '✻ Herding… (4s · ↓ 108 tokens · thought for 2s)',
    '* Herding… (5s · ↓ 180 tokens · thought for 2s)',
    '✶ Herding… (7s · ↓ 192 tokens)',
    '✢ Herding… (running stop hooks… 0/4 · 13s · ↓ 366 tokens)',
    '◦ Working (22s • esc to interrupt)',
    '• Working (2s • esc to interrupt)'
  ]

  for (const line of working) {
    it('reads as busy: ' + line.slice(0, 44), () => {
      expect(cliBusyOf([' something above', line, '  ────'])).toBe(true)
    })
  }

  it('reads as idle once the line says it is done', () => {
    expect(cliBusyOf(['✻ Cooked for 13s · done 오후 12:51'])).toBe(false)
    expect(cliBusyOf(['✻ Sautéed for 2s · done 오후 12:45'])).toBe(false)
  })

  it('reads as idle at an ordinary prompt', () => {
    expect(
      cliBusyOf([
        '  [Opus 5 (1M context)] │ mprobe',
        '───────────',
        '> ',
        '───────────'
      ])
    ).toBe(false)
  })

  // The transcript shape that used to stand in for this: a command leaves a user turn and no answer,
  // and the CLI is plainly idle underneath it.
  it('reads as idle after a command the CLI answered on its own screen', () => {
    expect(cliBusyOf(['> /model default', '  Set model to default', '> '])).toBe(false)
  })

  it('says nothing for a screen it cannot read', () => {
    expect(cliBusyOf([])).toBe(false)
  })
})
