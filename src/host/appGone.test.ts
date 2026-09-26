import { describe, it, expect, vi } from 'vitest'
import { createAppGoneWatch, createAppLeftGrace } from './appGone'

const rig = (pid: { now: number | null }) => {
  let app = true
  const timers: Array<{ fn: () => void; cancelled: boolean }> = []
  const gone: string[] = []
  const w = createAppGoneWatch({
    hasApp: () => app,
    appPid: () => pid.now,
    onGone: (why) => gone.push(why),
    log: () => {},
    after: (_ms, fn) => {
      const t = { fn, cancelled: false }
      timers.push(t)
      return () => { t.cancelled = true }
    }
  })
  w.appsChanged() // the app's hello, as the server reports it (B2: the watch reads nothing when built)
  return {
    w,
    gone,
    leave: () => { app = false; w.appsChanged() },
    attach: () => { app = true; w.appsChanged() },
    graceEnds: () => { for (const t of timers.splice(0)) if (!t.cancelled) t.fn() },
    timers
  }
}

describe('createAppGoneWatch (S6 R25, design §3A.3)', () => {
  it('a quit (app.pid removed) is gone once the grace ends', () => {
    const pid: { now: number | null } = { now: 100 }
    const r = rig(pid)
    r.leave()
    pid.now = null
    r.graceEnds()
    expect(r.gone).toHaveLength(1)
  })
  it('a dropped socket whose app lives keeps its sessions, and a reconnect ends the question (Review Focus 1)', () => {
    const pid: { now: number | null } = { now: 100 }
    const r = rig(pid)
    r.leave()
    r.graceEnds() // app.pid still names 100: kept
    r.w.tick()
    expect(r.gone).toEqual([])
    r.attach() // the same app back
    r.w.tick()
    pid.now = null
    r.w.tick() // an app is attached: nothing is decided on a tick
    expect(r.gone).toEqual([])
  })
  it('a kept app that later quits without reconnecting is gone at the next tick with no app', () => {
    const pid: { now: number | null } = { now: 100 }
    const r = rig(pid)
    r.leave()
    r.graceEnds()
    pid.now = null
    r.w.tick()
    expect(r.gone).toHaveLength(1)
    r.w.tick()
    expect(r.gone).toHaveLength(2) // and again on each tick after, R13: the pass is idempotent
  })
  it('reads nothing at construction, so it can be built before the server exists (preflight B2)', () => {
    expect(() =>
      createAppGoneWatch({ hasApp: () => { throw new Error('no server yet') }, appPid: () => null, onGone: () => {}, log: () => {} })
    ).not.toThrow()
  })
  it('after a gone decision, every tick with no app attached runs the pass again, until an app attaches (preflight R13)', () => {
    const pid: { now: number | null } = { now: 100 }
    const r = rig(pid)
    r.leave()
    pid.now = null
    r.graceEnds()
    expect(r.gone).toHaveLength(1)
    r.w.tick()
    r.w.tick()
    expect(r.gone).toHaveLength(3)
    r.attach()
    r.w.tick()
    expect(r.gone).toHaveLength(3)
  })
  it('an app that attaches within the grace cancels it, whatever its pid (a new instance restores itself)', () => {
    const pid: { now: number | null } = { now: 100 }
    const r = rig(pid)
    r.leave()
    pid.now = 200
    r.attach()
    r.graceEnds()
    r.w.tick()
    expect(r.gone).toEqual([])
  })
  it('an app that attaches after a gone decision ends it: leaving again waits out a new grace, not the next tick (fix round 1)', () => {
    const pid: { now: number | null } = { now: 100 }
    const r = rig(pid)
    r.leave()
    pid.now = null
    r.graceEnds()
    expect(r.gone).toHaveLength(1)
    r.attach() // a new instance restores the chains itself
    pid.now = 200
    r.leave()
    r.w.tick() // inside the new grace: nothing is decided on a tick
    expect(r.gone).toHaveLength(1)
  })
  it('dispose cancels the grace waiting to decide (fix round 1)', () => {
    const pid: { now: number | null } = { now: 100 }
    const r = rig(pid)
    r.leave()
    pid.now = null
    expect(r.timers.filter((t) => !t.cancelled)).toHaveLength(1)
    r.w.dispose()
    expect(r.timers.filter((t) => !t.cancelled)).toHaveLength(0)
    r.graceEnds()
    r.w.tick()
    expect(r.gone).toEqual([])
  })
})

// Leftovers Task 1 (S6-5): one app-left rule for both watchers. driving.ts runs it with
// `attachCancels: false` (an attach within the grace decides by pid), appGone's watch with `true` (A69: an
// attach cancels whatever the pid). One table drives both, so a change to one is a change to the other.
describe('createAppLeftGrace, the app-left rule both watchers run (S6-5)', () => {
  type Step = 'leave' | 'attach' | 'graceEnds' | 'tick' | ['pid', number | null]
  const run = (attachCancels: boolean, steps: Step[]) => {
    let app = true
    let pid: number | null = 100
    let clock = 1000
    const timers: Array<{ fn: () => void; cancelled: boolean }> = []
    const gone: Array<{ why: string; leftAt: number; appAttached: boolean }> = []
    const g = createAppLeftGrace({
      hasApp: () => app,
      appPid: () => pid,
      attachCancels,
      onGone: (e) => gone.push(e),
      log: () => {},
      nowMs: () => clock,
      after: (_ms, fn) => {
        const t = { fn, cancelled: false }
        timers.push(t)
        return () => { t.cancelled = true }
      }
    })
    for (const s of steps) {
      clock += 10
      if (s === 'leave') { app = false; g.left() }
      else if (s === 'attach') { app = true; g.attached() }
      else if (s === 'graceEnds') { for (const t of timers.splice(0)) if (!t.cancelled) t.fn() }
      else if (s === 'tick') g.tick()
      else pid = s[1]
    }
    return gone
  }
  const table: Array<{ name: string; steps: Step[]; driver: number; watch: number }> = [
    { name: 'a quit (no live pid) is gone when the grace ends', steps: ['leave', ['pid', null], 'graceEnds'], driver: 1, watch: 1 },
    { name: 'the same live pid at the grace end keeps what it left', steps: ['leave', 'graceEnds', 'tick'], driver: 0, watch: 0 },
    { name: 'a kept app that quits is gone at the next tick', steps: ['leave', 'graceEnds', ['pid', null], 'tick'], driver: 1, watch: 1 },
    { name: 'a kept app back with the same pid keeps it', steps: ['leave', 'graceEnds', 'attach', ['pid', null], 'tick'], driver: 0, watch: 0 },
    { name: 'the same pid back within the grace keeps it', steps: ['leave', 'attach', 'graceEnds'], driver: 0, watch: 0 },
    { name: 'a new instance within the grace: the driver runs the steps, the takeover is cancelled (A69)', steps: ['leave', ['pid', 200], 'attach', 'graceEnds'], driver: 1, watch: 0 },
    { name: 'a new instance after a kept grace: the driver runs the steps, the takeover is cancelled (A69)', steps: ['leave', 'graceEnds', ['pid', 200], 'attach', 'tick'], driver: 1, watch: 0 },
    { name: 'no pid known at the leave cannot be the same app', steps: [['pid', null], 'leave', 'graceEnds'], driver: 1, watch: 1 },
    { name: 'a tick inside the grace decides nothing', steps: ['leave', ['pid', null], 'tick'], driver: 0, watch: 0 }
  ]
  for (const row of table) {
    it(row.name, () => {
      expect(run(false, row.steps), 'driving.ts').toHaveLength(row.driver)
      expect(run(true, row.steps), 'appGone.ts').toHaveLength(row.watch)
    })
  }
  it('says when the app left and whether one is attached at the decision', () => {
    expect(run(false, ['leave', ['pid', 200], 'attach'])).toEqual([{ why: expect.any(String), leftAt: 1010, appAttached: true }])
    expect(run(false, ['leave', ['pid', null], 'graceEnds'])).toEqual([{ why: expect.any(String), leftAt: 1010, appAttached: false }])
  })
})
