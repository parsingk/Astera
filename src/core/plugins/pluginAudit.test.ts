import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AUDIT_DETAIL_MAX, createPluginAudit, readPluginAudit, type PluginAuditEntry } from './pluginAudit'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-audit-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

const linesOf = async (file: string): Promise<PluginAuditEntry[]> =>
  (await fs.readFile(file, 'utf8'))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as PluginAuditEntry)

/** A timer the test fires by hand. */
const manualTimers = () => {
  const due: { fn: () => void; ms: number }[] = []
  return {
    setTimer: (fn: () => void, ms: number) => {
      due.push({ fn, ms })
    },
    fire: () => {
      const now = due.splice(0)
      for (const t of now) t.fn()
    },
    count: () => due.length
  }
}

describe('the plugin audit log', () => {
  it('writes one JSON line per record with the time, and reads it back', async () => {
    const file = path.join(dir, 'plugins', 'audit.jsonl')
    const audit = createPluginAudit({ file, now: () => 1000 })
    audit.record({ plugin: 'acme.hello', event: 'installed', by: 'cli', version: '1.0.0', detail: 'restricted-ui, granted nothing' })
    audit.record({ plugin: 'acme.hello', event: 'enabled' })
    await audit.flushed()
    expect(await linesOf(file)).toEqual([
      { at: 1000, plugin: 'acme.hello', event: 'installed', by: 'cli', version: '1.0.0', detail: 'restricted-ui, granted nothing' },
      { at: 1000, plugin: 'acme.hello', event: 'enabled' }
    ])
    expect(await readPluginAudit([file], { lines: 10 })).toEqual(await linesOf(file))
  })

  it('takes the time a record names, for a change recorded after the moment it was asked for', async () => {
    const file = path.join(dir, 'audit.jsonl')
    const audit = createPluginAudit({ file, now: () => 9 })
    audit.record({ plugin: 'p', event: 'removed', at: 4 })
    await audit.flushed()
    expect(await linesOf(file)).toEqual([{ at: 4, plugin: 'p', event: 'removed' }])
  })

  it('cuts a detail to AUDIT_DETAIL_MAX and takes control characters out of it', async () => {
    const file = path.join(dir, 'audit.jsonl')
    const audit = createPluginAudit({ file, now: () => 1 })
    const esc = String.fromCharCode(27)
    audit.record({ plugin: `a${esc}[31m`, event: 'call-refused', detail: `line one\nline two${esc}[2J\tend` })
    audit.record({ plugin: 'a', event: 'call-refused', detail: 'x'.repeat(AUDIT_DETAIL_MAX + 50) })
    await audit.flushed()
    const [first, second] = await linesOf(file)
    expect(first.plugin).toBe('a[31m')
    expect(first.detail).toBe('line one line two[2J end')
    // Review: direction overrides would make a terminal line read other than it is
    audit.record({ plugin: 'a', event: 'call-refused', detail: `jobs${String.fromCharCode(0x202e)}-list${String.fromCharCode(0x2066)}` })
    await audit.flushed()
    expect((await linesOf(file))[2].detail).toBe('jobs-list')
    expect(second.detail).toHaveLength(AUDIT_DETAIL_MAX)
    expect(second.detail?.endsWith('…')).toBe(true)
  })

  it('writes the first record of a coalesced key, counts the rest, and writes one line with repeated when the window ends', async () => {
    const file = path.join(dir, 'audit.jsonl')
    const t = manualTimers()
    let now = 10
    const audit = createPluginAudit({ file, now: () => now, setTimer: t.setTimer })
    for (let i = 0; i < 50; i++) {
      now = 10 + i
      audit.record({ plugin: 'acme.flood', event: 'bridge-refused', detail: 'TOO_MANY_CALLS' }, 'acme.flood bridge TOO_MANY_CALLS')
    }
    await audit.flushed()
    expect(await linesOf(file)).toHaveLength(1)
    t.fire()
    await audit.flushed()
    const lines = await linesOf(file)
    expect(lines).toEqual([
      { at: 10, plugin: 'acme.flood', event: 'bridge-refused', detail: 'TOO_MANY_CALLS' },
      { at: 59, plugin: 'acme.flood', event: 'bridge-refused', detail: 'TOO_MANY_CALLS', repeated: 49 }
    ])
    // A window that ended with a count stays open for the next burst; one that saw nothing more closes
    expect(t.count()).toBe(1)
    t.fire()
    expect(t.count()).toBe(0)
    audit.record({ plugin: 'acme.flood', event: 'bridge-refused', detail: 'TOO_MANY_CALLS' }, 'acme.flood bridge TOO_MANY_CALLS')
    await audit.flushed()
    expect(await linesOf(file)).toHaveLength(3)
  })

  // Final review I1: a process that leaves inside a window kept the count in memory only
  it('drain writes the count of a window still open, and the writer goes on', async () => {
    const file = path.join(dir, 'audit.jsonl')
    const t = manualTimers()
    const audit = createPluginAudit({ file, now: () => 3, setTimer: t.setTimer })
    for (let i = 0; i < 5; i++) audit.record({ plugin: 'p', event: 'call-refused', detail: 'x' }, 'p call-refused x')
    await audit.drain()
    expect(await linesOf(file)).toEqual([
      { at: 3, plugin: 'p', event: 'call-refused', detail: 'x' },
      { at: 3, plugin: 'p', event: 'call-refused', detail: 'x', repeated: 4 }
    ])
    // The window is gone: its timer finds nothing to write, and a record after it starts a new one
    t.fire()
    audit.record({ plugin: 'p', event: 'call-refused', detail: 'x' }, 'p call-refused x')
    await audit.flushed()
    expect(await linesOf(file)).toHaveLength(3)
  })

  // Final review I1: Electron does not wait on a promise at quit, so the app writes what it holds at once
  it('drainSync writes the queued records and the open counts at once', async () => {
    const file = path.join(dir, 'plugins', 'audit-app.jsonl')
    const t = manualTimers()
    const audit = createPluginAudit({ file, now: () => 8, setTimer: t.setTimer })
    audit.record({ plugin: 'p', event: 'panel-opened', detail: 'panel main' })
    for (let i = 0; i < 3; i++) audit.record({ plugin: 'p', event: 'bridge-refused', detail: 'TOO_MANY_CALLS' }, 'p bridge TOO_MANY_CALLS')
    audit.drainSync()
    const lines = await linesOf(file)
    expect(lines.map((l) => [l.event, l.repeated])).toEqual([
      ['panel-opened', undefined],
      ['bridge-refused', undefined],
      ['bridge-refused', 2]
    ])
    // What the async chain was given already finds nothing left to write twice
    await audit.flushed()
    expect(await linesOf(file)).toHaveLength(3)
  })

  // Final review M10: the writer's side of a torn line, a Review Focus item
  it('starts a new line after a torn last line left by a writer that died', async () => {
    const file = path.join(dir, 'audit.jsonl')
    await fs.writeFile(file, `${JSON.stringify({ at: 1, plugin: 'a', event: 'installed' })}\n{"at":2,"plugin":"a","eve`)
    const audit = createPluginAudit({ file, now: () => 3 })
    audit.record({ plugin: 'a', event: 'enabled' })
    await audit.flushed()
    expect((await readPluginAudit([file], { lines: 10 })).map((e) => e.at)).toEqual([1, 3])
    const sync = path.join(dir, 'sync.jsonl')
    await fs.writeFile(sync, '{"at":2,"plug')
    const other = createPluginAudit({ file: sync, now: () => 4 })
    other.record({ plugin: 'a', event: 'enabled' })
    other.drainSync()
    expect((await readPluginAudit([sync], { lines: 10 })).map((e) => e.at)).toEqual([4])
  })

  it('writes nothing more when a coalesced key saw only its first record', async () => {
    const file = path.join(dir, 'audit.jsonl')
    const t = manualTimers()
    const audit = createPluginAudit({ file, now: () => 5, setTimer: t.setTimer })
    audit.record({ plugin: 'p', event: 'exited', detail: 'code 1' }, 'p exited')
    t.fire()
    await audit.flushed()
    expect(await linesOf(file)).toEqual([{ at: 5, plugin: 'p', event: 'exited', detail: 'code 1' }])
    expect(t.count()).toBe(0)
  })

  it('rotates to <file>.1 past the segment size, keeping two generations', async () => {
    const file = path.join(dir, 'audit.jsonl')
    const audit = createPluginAudit({ file, now: () => 1, segmentBytes: 200 })
    for (let i = 0; i < 12; i++) audit.record({ plugin: 'p', event: 'call', detail: `jobs-create ${i}` })
    await audit.flushed()
    const names = (await fs.readdir(dir)).sort()
    expect(names).toEqual(['audit.jsonl', 'audit.jsonl.1'])
    expect((await fs.stat(file)).size).toBeLessThanOrEqual(200)
    expect((await fs.stat(`${file}.1`)).size).toBeLessThanOrEqual(200)
    const kept = await readPluginAudit([file], { lines: 100 })
    expect(kept.at(-1)?.detail).toBe('jobs-create 11')
    expect(kept.length).toBeLessThan(12)
  })

  it('keeps writing after a failed write, and reports it once', async () => {
    const blocker = path.join(dir, 'blocker')
    await fs.writeFile(blocker, '')
    const file = path.join(blocker, 'audit.jsonl')
    const errors: string[] = []
    const audit = createPluginAudit({ file, now: () => 1, onError: (m) => errors.push(m) })
    audit.record({ plugin: 'p', event: 'started' })
    audit.record({ plugin: 'p', event: 'stopped' })
    await audit.flushed()
    expect(errors).toHaveLength(1)
    await fs.rm(blocker)
    audit.record({ plugin: 'p', event: 'started', detail: 'pid 7' })
    await audit.flushed()
    expect(await linesOf(file)).toEqual([{ at: 1, plugin: 'p', event: 'started', detail: 'pid 7' }])
  })

  it('reads both generations of each file, merges files by time, filters by plugin and keeps the last lines', async () => {
    const host = path.join(dir, 'audit.jsonl')
    const app = path.join(dir, 'audit-app.jsonl')
    const line = (e: PluginAuditEntry): string => `${JSON.stringify(e)}\n`
    await fs.writeFile(`${host}.1`, line({ at: 1, plugin: 'a', event: 'installed' }))
    await fs.writeFile(host, line({ at: 3, plugin: 'a', event: 'enabled' }) + line({ at: 5, plugin: 'b', event: 'removed' }))
    await fs.writeFile(app, line({ at: 2, plugin: 'a', event: 'panel-opened' }) + line({ at: 4, plugin: 'a', event: 'bridge-refused' }))
    expect((await readPluginAudit([host, app], { lines: 100 })).map((e) => e.at)).toEqual([1, 2, 3, 4, 5])
    expect((await readPluginAudit([host, app], { plugin: 'a', lines: 2 })).map((e) => e.event)).toEqual(['enabled', 'bridge-refused'])
    expect(await readPluginAudit([path.join(dir, 'none.jsonl')], { lines: 10 })).toEqual([])
  })

  it('skips a torn or foreign line instead of failing the read', async () => {
    const file = path.join(dir, 'audit.jsonl')
    await fs.writeFile(
      file,
      [
        JSON.stringify({ at: 1, plugin: 'a', event: 'installed' }),
        '{"at":2,"plugin":"a","eve',
        JSON.stringify({ at: 3, plugin: 'a', event: 'not-an-event' }),
        JSON.stringify({ at: 'x', plugin: 'a', event: 'enabled' }),
        // Final review M5: a number no date can hold
        JSON.stringify({ at: 1e20, plugin: 'a', event: 'enabled' }),
        JSON.stringify({ at: 4, plugin: 'a', event: 'enabled' }),
        ''
      ].join('\n')
    )
    expect((await readPluginAudit([file], { lines: 10 })).map((e) => e.at)).toEqual([1, 4])
  })
})
