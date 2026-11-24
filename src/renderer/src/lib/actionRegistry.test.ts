import { describe, it, expect, vi } from 'vitest'
import { createActionRegistry } from './actionRegistry'

describe('createActionRegistry', () => {
  it('runs a registered handler and reports it runnable', () => {
    const reg = createActionRegistry()
    const run = vi.fn()
    reg.register('core', 'sidebar.jobs', { run })
    expect(reg.state('sidebar.jobs')).toEqual({ ok: true })
    expect(reg.run('sidebar.jobs')).toEqual({ ok: true })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('reports why a blocked action cannot run, and does not run it', () => {
    const reg = createActionRegistry()
    const run = vi.fn()
    reg.register('core', 'job.new', { blockedBy: () => 'action.blocked.noProject', run })
    expect(reg.state('job.new')).toEqual({ ok: false, reason: 'action.blocked.noProject' })
    expect(reg.run('job.new')).toEqual({ ok: false, reason: 'action.blocked.noProject' })
    expect(run).not.toHaveBeenCalled()
  })

  it('asks blockedBy at the moment of the call, not at registration', () => {
    const reg = createActionRegistry()
    let project: string | null = null
    const run = vi.fn()
    reg.register('core', 'job.new', { blockedBy: () => (project ? null : 'action.blocked.noProject'), run })
    expect(reg.run('job.new').ok).toBe(false)
    project = 'D:/p'
    expect(reg.run('job.new').ok).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('reports an action with no handler as blocked, so a missing handler is visible', () => {
    const reg = createActionRegistry()
    expect(reg.state('run.run')).toEqual({ ok: false, reason: 'action.blocked.noHandler' })
    expect(reg.run('run.run')).toEqual({ ok: false, reason: 'action.blocked.noHandler' })
  })

  it('refuses a second handler for the same id and keeps the first', () => {
    const reg = createActionRegistry()
    const first = vi.fn()
    const second = vi.fn()
    reg.register('core', 'run.run', { run: first })
    expect(() => reg.register('example.plugin', 'run.run', { run: second })).toThrow(/run\.run/)
    reg.run('run.run')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it('lets a disposer remove only the entry it registered', () => {
    const reg = createActionRegistry()
    const old = vi.fn()
    const fresh = vi.fn()
    const disposeOld = reg.register('core', 'kube.open', { run: old })
    disposeOld()
    expect(reg.state('kube.open').ok).toBe(false)
    reg.register('core', 'kube.open', { run: fresh })
    disposeOld() // a stale disposer must not take the newer handler with it
    reg.run('kube.open')
    expect(fresh).toHaveBeenCalledTimes(1)
    expect(old).not.toHaveBeenCalled()
  })

  it('disposes every entry of one owner and none of another, and runs nothing it disposed', () => {
    const reg = createActionRegistry()
    const pluginRun = vi.fn()
    reg.register('example.plugin', 'session.new', { run: pluginRun })
    reg.register('example.plugin', 'job.new', { run: vi.fn() })
    reg.register('core', 'kube.open', { run: vi.fn() })
    reg.disposeOwner('example.plugin')
    expect(reg.state('session.new').ok).toBe(false)
    expect(reg.state('job.new').ok).toBe(false)
    expect(reg.state('kube.open').ok).toBe(true)
    expect(reg.run('session.new')).toEqual({ ok: false, reason: 'action.blocked.noHandler' })
    expect(pluginRun).not.toHaveBeenCalled()
  })
})
