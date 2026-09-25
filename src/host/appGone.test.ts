import { describe, it, expect, vi } from 'vitest'
import { createAppGoneWatch } from './appGone'

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
