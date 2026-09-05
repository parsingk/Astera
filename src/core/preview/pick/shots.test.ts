import { describe, it, expect } from 'vitest'
import { SHOT_LIMITS, evictionPlan } from './shots'

const DAY = 24 * 60 * 60 * 1000
const now = 1_800_000_000_000
const file = (i: number, ageMs: number) => ({ path: `s/${i}.png`, mtimeMs: now - ageMs })

describe('evictionPlan', () => {
  it('nothing to do under both limits', () => {
    expect(evictionPlan([file(1, 0), file(2, DAY)], now)).toEqual([])
  })
  it('deletes everything older than the age limit', () => {
    const plan = evictionPlan([file(1, 8 * DAY), file(2, 9 * DAY), file(3, 1 * DAY)], now)
    expect(plan.sort()).toEqual(['s/1.png', 's/2.png'])
  })
  it('deletes the oldest beyond the file cap, keeping exactly maxFiles', () => {
    const files = Array.from({ length: SHOT_LIMITS.maxFiles + 3 }, (_, i) => file(i, i * 1000))
    const plan = evictionPlan(files, now)
    expect(plan).toEqual([`s/${SHOT_LIMITS.maxFiles + 2}.png`, `s/${SHOT_LIMITS.maxFiles + 1}.png`, `s/${SHOT_LIMITS.maxFiles}.png`])
  })
  it('age and count together, without duplicates', () => {
    const files = [...Array.from({ length: SHOT_LIMITS.maxFiles + 1 }, (_, i) => file(i, i * 1000)), file(999, 10 * DAY)]
    const plan = evictionPlan(files, now)
    expect(new Set(plan).size).toBe(plan.length)
    expect(plan).toContain('s/999.png')
    expect(plan).toContain(`s/${SHOT_LIMITS.maxFiles}.png`)
    expect(plan).toHaveLength(2)
  })
  it('honours custom limits', () => {
    expect(evictionPlan([file(1, 0), file(2, 10), file(3, 20)], now, { maxFiles: 1, maxAgeMs: DAY })).toEqual(['s/3.png', 's/2.png'])
  })
})
