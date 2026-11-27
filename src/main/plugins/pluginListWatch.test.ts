import { describe, it, expect } from 'vitest'
import { createPluginListWatch } from './pluginListWatch'
import type { PluginRow } from '../../core/plugins/pluginRows'

const row = (over: Partial<PluginRow> = {}): PluginRow => ({ id: 'dusk-theme', enabled: true, status: 'ready', dir: '/p/dusk', permissions: ['themes.register'], ...over })

describe('createPluginListWatch', () => {
  it('says the list changed the first time it reads one, and again only when it differs', async () => {
    let list: PluginRow[] | null = [row()]
    let sent = 0
    const w = createPluginListWatch({ list: async () => list, send: () => sent++ })
    await w.check()
    expect(sent).toBe(1)
    await w.check()
    expect(sent).toBe(1)
    list = [row({ enabled: false })]
    await w.check()
    expect(sent).toBe(2)
  })

  it('says nothing for a list it cannot read: a Host restarting is not a Host saying the plugins are gone', async () => {
    let list: PluginRow[] | null = [row()]
    let sent = 0
    const w = createPluginListWatch({ list: async () => list, send: () => sent++ })
    await w.check()
    list = null
    await w.check()
    expect(sent).toBe(1)
    list = [row()]
    await w.check()
    expect(sent).toBe(1)
  })

  it('does not read twice at once: a check that finds one under way waits for it', async () => {
    let calls = 0
    let release: () => void = () => {}
    const w = createPluginListWatch({
      list: () => {
        calls++
        return new Promise((resolve) => {
          release = () => resolve([row()])
        })
      },
      send: () => {}
    })
    const a = w.check()
    const b = w.check()
    release()
    await Promise.all([a, b])
    expect(calls).toBe(1)
  })
})
