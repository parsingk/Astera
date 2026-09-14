import { describe, it, expect } from 'vitest'
import {
  carryRolledView,
  openSessionView,
  sessionViewOf,
  setSessionView,
  withoutClosedSessions
} from './sessionView'

describe('openSessionView', () => {
  // Requirement 1: a new session tab takes its view from the setting.
  it('seeds a session with no entry from the given default', () => {
    const result = openSessionView({}, 's1', 'conversation')
    expect(sessionViewOf(result, 's1', 'terminal')).toBe('conversation')
  })

  // Requirement 2: changing the setting does not change a tab that already exists. PaneGrid calls
  // openSessionView again on every render of the sessions list, passing whatever the setting reads
  // right now — so a session that already has an entry has to come back untouched even when the
  // default argument itself has since changed, or the whole feature would flip every open tab the
  // moment someone changed the setting in Settings.
  it('is a no-op — same reference back — for a session that already has an entry, even with a different default', () => {
    const seeded = openSessionView({}, 's1', 'terminal')
    const result = openSessionView(seeded, 's1', 'conversation')
    expect(result).toBe(seeded)
    expect(sessionViewOf(result, 's1', 'conversation')).toBe('terminal')
  })

  it('leaves an unrelated session in the map alone', () => {
    const seeded = openSessionView({}, 's1', 'terminal')
    const result = openSessionView(seeded, 's2', 'conversation')
    expect(sessionViewOf(result, 's1', 'terminal')).toBe('terminal')
    expect(sessionViewOf(result, 's2', 'terminal')).toBe('conversation')
  })
})

describe('sessionViewOf', () => {
  // Fix round 1: the fallback used to be a hardcoded 'terminal' literal, which read wrong on a
  // brand-new tab's very first paint whenever the actual setting was 'conversation' — the seeding
  // effect that would have corrected it runs one render later. Two different defaults, both
  // honoured exactly, is what distinguishes "reads the parameter" from "reads a literal that happens
  // to equal one of these two values".
  it("falls back to the given default for a session with no entry — 'terminal'", () => {
    expect(sessionViewOf({}, 'unknown', 'terminal')).toBe('terminal')
  })

  it("falls back to the given default for a session with no entry — 'conversation'", () => {
    expect(sessionViewOf({}, 'unknown', 'conversation')).toBe('conversation')
  })

  it('reads the stored entry over the default when one exists', () => {
    expect(sessionViewOf({ s1: 'conversation' }, 's1', 'terminal')).toBe('conversation')
  })
})

describe('setSessionView', () => {
  // Requirement 3: the choice is remembered per tab — two tabs, set differently, each keep their own.
  it('keeps two sessions set to different views apart', () => {
    const a = setSessionView({}, 's1', 'conversation')
    const b = setSessionView(a, 's2', 'terminal')
    expect(sessionViewOf(b, 's1', 'terminal')).toBe('conversation')
    expect(sessionViewOf(b, 's2', 'terminal')).toBe('terminal')
  })

  it('is a no-op — same reference back — when the value does not change', () => {
    const seeded = setSessionView({}, 's1', 'terminal')
    const result = setSessionView(seeded, 's1', 'terminal')
    expect(result).toBe(seeded)
  })

  it('overwrites a session already holding the other view', () => {
    const seeded = setSessionView({}, 's1', 'terminal')
    const result = setSessionView(seeded, 's1', 'conversation')
    expect(sessionViewOf(result, 's1', 'terminal')).toBe('conversation')
  })
})

describe('carryRolledView', () => {
  // Fix round 1: session:rolled swaps a tab's session id in place. Without this, the tab's
  // remembered view is silently reset to the setting's default — a person mid-conversation gets
  // snapped back to the terminal for having done nothing.
  it("moves the old session's view to the new id and drops the old entry", () => {
    const views = { old: 'conversation' as const }
    const result = carryRolledView(views, 'old', 'new')
    expect(result).toEqual({ new: 'conversation' })
    expect(Object.prototype.hasOwnProperty.call(result, 'old')).toBe(false)
  })

  it('leaves an unrelated session in the map alone', () => {
    const views = { old: 'conversation' as const, other: 'terminal' as const }
    const result = carryRolledView(views, 'old', 'new')
    expect(result).toEqual({ new: 'conversation', other: 'terminal' })
  })

  // Same reference back, not just "no visible change" — PaneGrid's seeding effect calls this on
  // every render alongside openSessionView/withoutClosedSessions, so a version that always allocates
  // a fresh object here would cost a re-render on every unrelated session-list change, not only the
  // one render a roll actually happens on.
  it('is a no-op — same reference back — when the old id has no entry', () => {
    const views = { other: 'terminal' as const }
    const result = carryRolledView(views, 'old', 'new')
    expect(result).toBe(views)
  })

  // Guards against re-applying a roll event a second time (e.g. a stale prop reference triggering
  // the effect again for an unrelated reason) from clobbering a choice already carried, or made
  // since, at the new id.
  it('is a no-op — same reference back — when the new id already has an entry', () => {
    const views = { old: 'conversation' as const, new: 'terminal' as const }
    const result = carryRolledView(views, 'old', 'new')
    expect(result).toBe(views)
  })
})

describe('withoutClosedSessions', () => {
  // Requirement 4: a tab that closes and a session that ends do not leave their remembered choice
  // behind — both reach this the same way, as an id missing from the live set.
  it('drops a session missing from the live set and keeps the rest', () => {
    const views = { s1: 'conversation' as const, s2: 'terminal' as const }
    const result = withoutClosedSessions(views, new Set(['s2']))
    expect(result).toEqual({ s2: 'terminal' })
    expect(Object.prototype.hasOwnProperty.call(result, 's1')).toBe(false)
  })

  // Reference identity, not just content — named directly because a version that always returns a
  // fresh object (correct content, wrong reference) would still pass the assertion above while
  // costing PaneGrid a re-render on every session list change even when nothing actually closed.
  it('is the same reference back when nothing is stale', () => {
    const views = { s1: 'conversation' as const }
    const result = withoutClosedSessions(views, new Set(['s1']))
    expect(result).toBe(views)
  })

  it('drops every entry when the live set is empty', () => {
    const views = { s1: 'conversation' as const, s2: 'terminal' as const }
    const result = withoutClosedSessions(views, new Set())
    expect(result).toEqual({})
  })
})
