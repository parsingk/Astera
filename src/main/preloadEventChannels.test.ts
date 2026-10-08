// Every event main sends to the renderer has to be on the preload's list, or `api.on` throws at the first subscribe and
// the window stays blank (Phase 9b hand check: `session:reset` was missing and the app never drew). The preload imports
// electron, so the list is read from its source, against the event map's keys in core/types.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const read = (p: string): string => readFileSync(path.join(__dirname, p), 'utf8')

describe('preload event channels', () => {
  it('lists every event of CoreEvents', () => {
    const preload = read('../preload/index.ts')
    const list = preload.slice(preload.indexOf('const EVENT_CHANNELS = ['), preload.indexOf(']', preload.indexOf('const EVENT_CHANNELS = [')))
    const channels = new Set([...list.matchAll(/'([^']+)'/g)].map((m) => m[1]))
    const types = read('../core/types.ts')
    const start = types.indexOf('export interface CoreEvents {')
    const body = types.slice(start, types.indexOf('\n}', start))
    const events = [...body.matchAll(/^ {2}'([^']+)':/gm)].map((m) => m[1])
    expect(events.length).toBeGreaterThan(10)
    expect(events.filter((e) => !channels.has(e))).toEqual([])
  })
})
