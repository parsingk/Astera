import { describe, it, expect } from 'vitest'
import { ACCOUNT_COLORS, hueOf, nextAccountColor } from './colors'

/** Distance between two hues around the circle: 350° and 10° are 20° apart. */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return Math.min(d, 360 - d)
}

/** How far `hex` sits from the nearest colour in `taken`. 360 when nothing is taken. */
function nearestGap(hex: string, taken: readonly string[]): number {
  const h = hueOf(hex)
  expect(h).not.toBeNull()
  const hues = taken.map(hueOf).filter((x): x is number => x !== null)
  if (hues.length === 0) return 360
  return Math.min(...hues.map((t) => hueGap(h as number, t)))
}

describe('hueOf', () => {
  it('reads a hex colour as a hue', () => {
    expect(hueOf('#ef4444')).toBe(0) // red
    expect(hueOf('#22c55e')).toBeCloseTo(142, 0) // green
    expect(hueOf('#4f9cf9')).toBeCloseTo(213, 0) // blue
  })

  it('answers null for anything that is not a six-digit hex', () => {
    expect(hueOf('')).toBeNull()
    expect(hueOf('rebeccapurple')).toBeNull()
    expect(hueOf('#12345')).toBeNull()
  })
})

describe('ACCOUNT_COLORS', () => {
  it('holds no colour twice', () => {
    expect(new Set(ACCOUNT_COLORS).size).toBe(ACCOUNT_COLORS.length)
  })

  it('keeps the original six in front, order included', () => {
    // Accounts registered before the palette grew keep their stored colour only while this holds.
    expect(ACCOUNT_COLORS.slice(0, 6)).toEqual([
      '#4f9cf9',
      '#f97316',
      '#22c55e',
      '#e879f9',
      '#facc15',
      '#ef4444'
    ])
  })

  it('keeps every pair at least 15° apart in hue', () => {
    // The floor for telling two 9px dots apart. Adding a colour must not cross it.
    for (let i = 0; i < ACCOUNT_COLORS.length; i++) {
      for (let j = i + 1; j < ACCOUNT_COLORS.length; j++) {
        const gap = hueGap(hueOf(ACCOUNT_COLORS[i]) as number, hueOf(ACCOUNT_COLORS[j]) as number)
        expect(
          gap,
          `${ACCOUNT_COLORS[i]} and ${ACCOUNT_COLORS[j]} are ${gap.toFixed(0)}° apart`
        ).toBeGreaterThanOrEqual(15)
      }
    }
  })
})

describe('nextAccountColor', () => {
  it('starts at the first palette entry when nothing is taken', () => {
    expect(nextAccountColor([])).toBe(ACCOUNT_COLORS[0])
  })

  it('takes the first palette entry not already in use', () => {
    expect(nextAccountColor(ACCOUNT_COLORS.slice(0, 3))).toBe(ACCOUNT_COLORS[3])
  })

  it('refills a gap in the middle before moving on', () => {
    // The removed-then-added path. Handing back a colour another account still wears is the bug.
    const taken = ACCOUNT_COLORS.slice(0, 5).filter((c) => c !== ACCOUNT_COLORS[1])
    expect(nextAccountColor(taken)).toBe(ACCOUNT_COLORS[1])
  })

  it('generates a colour unlike any in the palette once the palette is full', () => {
    const color = nextAccountColor(ACCOUNT_COLORS)
    expect(ACCOUNT_COLORS).not.toContain(color)
    expect(color).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('puts the generated colour in the widest hue gap the palette leaves', () => {
    const color = nextAccountColor(ACCOUNT_COLORS)
    expect(nearestGap(color, ACCOUNT_COLORS)).toBeGreaterThanOrEqual(20)
  })

  it('keeps every colour distinct at three times the palette length', () => {
    const taken: string[] = []
    for (let i = 0; i < ACCOUNT_COLORS.length * 3; i++) taken.push(nextAccountColor(taken))
    expect(new Set(taken).size).toBe(taken.length)
  })

  it('avoids a taken colour that is not in the palette', () => {
    // accounts.json can hold a colour this palette never handed out.
    const taken = [...ACCOUNT_COLORS, '#123456']
    const color = nextAccountColor(taken)
    expect(taken).not.toContain(color)
  })

  it('still answers when a taken value cannot be read as a colour', () => {
    const color = nextAccountColor([...ACCOUNT_COLORS, 'not-a-color'])
    expect(color).toMatch(/^#[0-9a-f]{6}$/)
  })
})
