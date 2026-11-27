import { describe, it, expect } from 'vitest'
import { PLUGIN_CALL_METHODS_MAX, createPluginCalls } from './pluginCalls'

// Phase 2 remaining (spec E4, Plugin Inspector): how often each plugin called each Host command, and how often it was
// refused, since the Host started
describe('createPluginCalls', () => {
  it('counts calls and refusals per plugin and command', () => {
    const c = createPluginCalls()
    c.count('a', 'jobs-list', true)
    c.count('a', 'jobs-list', true)
    c.count('a', 'jobs-create', false)
    c.count('b', 'jobs-list', true)
    expect(c.of('a')).toEqual({ 'jobs-list': { ok: 2, refused: 0 }, 'jobs-create': { ok: 0, refused: 1 } })
    expect(c.of('b')).toEqual({ 'jobs-list': { ok: 1, refused: 0 } })
    expect(c.of('none')).toEqual({})
  })

  it('keeps at most PLUGIN_CALL_METHODS_MAX names a plugin, the rest under "other"', () => {
    const c = createPluginCalls()
    for (let i = 0; i < PLUGIN_CALL_METHODS_MAX + 5; i++) c.count('a', `m${i}`, false)
    const counts = c.of('a')
    expect(Object.keys(counts)).toHaveLength(PLUGIN_CALL_METHODS_MAX + 1)
    expect(counts.other).toEqual({ ok: 0, refused: 5 })
  })

  it('forgets a plugin removed', () => {
    const c = createPluginCalls()
    c.count('a', 'jobs-list', true)
    c.forget('a')
    expect(c.of('a')).toEqual({})
  })

  it('hands out a copy, so a caller cannot change the counts', () => {
    const c = createPluginCalls()
    c.count('a', 'jobs-list', true)
    c.of('a')['jobs-list'].ok = 99
    expect(c.of('a')['jobs-list'].ok).toBe(1)
  })
})
