// Observe history (lifecycle design §4, Review Focus 2): the whole days of records a usage finding may judge, from when
// Observe was last turned on or this release first ran, whichever is later, capped at the 30 days records are kept,
// less the local days stopped for size.
import { describe, it, expect } from 'vitest'
import { auditDayOf } from '../audit/store'
import { ageDays, observeHistory } from './history'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-10-30T12:00:00.000Z')
const ago = (ms: number): string => new Date(NOW - ms).toISOString()
const LONG_AGO = ago(400 * DAY)

describe('observeHistory', () => {
  it('on for 29 days and 23 hours counts 29', () => {
    const h = observeHistory({ policy: { mode: 'observe', observingSince: ago(29 * DAY + 23 * HOUR) }, findingsSince: LONG_AGO, stoppedDays: [], nowMs: NOW })
    expect(h).toEqual({ on: true, days: 29 })
  })

  it('caps at 30', () => {
    for (const mode of ['observe', 'enforce'] as const)
      expect(observeHistory({ policy: { mode, observingSince: ago(60 * DAY) }, findingsSince: LONG_AGO, stoppedDays: [], nowMs: NOW })).toEqual({
        on: true,
        days: 30
      })
  })

  it('a stopped day inside the counted days is not counted', () => {
    // On for 10 days: a day stopped 3 days ago is inside, one stopped 20 days ago is before Observe was on
    const ten = { policy: { mode: 'observe' as const, observingSince: ago(10 * DAY) }, findingsSince: LONG_AGO, nowMs: NOW }
    expect(observeHistory({ ...ten, stoppedDays: [auditDayOf(ago(3 * DAY)), auditDayOf(ago(20 * DAY))] })).toEqual({ on: true, days: 9 })
    // At the cap the counted days are the last 30: a day stopped 40 days ago is outside them
    const sixty = { policy: { mode: 'observe' as const, observingSince: ago(60 * DAY) }, findingsSince: LONG_AGO, nowMs: NOW }
    expect(observeHistory({ ...sixty, stoppedDays: [auditDayOf(ago(5 * DAY)), auditDayOf(ago(40 * DAY))] })).toEqual({ on: true, days: 29 })
    // Today stopped counts as not kept too, and the days never go below 0
    const one = { policy: { mode: 'observe' as const, observingSince: ago(DAY + HOUR) }, findingsSince: LONG_AGO, nowMs: NOW }
    expect(observeHistory({ ...one, stoppedDays: [auditDayOf(ago(0)), auditDayOf(ago(DAY))] })).toEqual({ on: true, days: 0 })
  })

  it('off gives on false and days 0', () => {
    expect(observeHistory({ policy: null, findingsSince: LONG_AGO, stoppedDays: [], nowMs: NOW })).toEqual({ on: false, days: 0 })
    // A stamp left in compatibility (a file edited by hand) does not turn it on
    expect(
      observeHistory({ policy: { mode: 'compatibility', observingSince: ago(40 * DAY) }, findingsSince: LONG_AGO, stoppedDays: [], nowMs: NOW })
    ).toEqual({ on: false, days: 0 })
  })

  it('the later of observingSince and findingsSince starts it', () => {
    const at = (observingSince: string | undefined, findingsSince: string) =>
      observeHistory({ policy: { mode: 'observe', ...(observingSince ? { observingSince } : {}) }, findingsSince, stoppedDays: [], nowMs: NOW }).days
    expect(at(ago(20 * DAY), ago(5 * DAY))).toBe(5)
    expect(at(ago(5 * DAY), ago(20 * DAY))).toBe(5)
    // Observe on before this release: counted from this release's first run (plan ruling 2)
    expect(at(undefined, ago(12 * DAY))).toBe(12)
    // A stamp that does not read as a time is passed over
    expect(at('not a time', ago(7 * DAY))).toBe(7)
  })
})

describe('ageDays', () => {
  it('counts whole days, never below 0, and reads nothing it cannot parse as a number', () => {
    expect(ageDays(ago(90 * DAY + 23 * HOUR), NOW)).toBe(90)
    expect(ageDays(ago(91 * DAY), NOW)).toBe(91)
    expect(ageDays(new Date(NOW + DAY).toISOString(), NOW)).toBe(0)
    expect(ageDays('never', NOW)).toBeNaN()
  })
})
