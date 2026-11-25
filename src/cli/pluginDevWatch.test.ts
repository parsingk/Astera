import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FolderCheck } from '../host/plugins/folderCheck'
import { devEventLine, runPluginDev, watchPluginFolder, type DevEvent } from './pluginDevWatch'

// Phase 2 step 4b (spec E4 dev): watch, check, reinstall with the grant first approved; anything new asked waits for the
// person. The file watcher, the folder check and the Host are fakes here; cli/run.ts wires the real ones.
afterEach(() => {
  vi.useRealTimers()
})

const approved = { grant: ['projects.read'], permissions: ['projects.read'], capabilities: [], trust: 'trusted' }
const clean: FolderCheck = { plugin: { id: 'p', name: 'p', version: '0.1.0', trust: 'trusted' }, problems: [], warnings: [] }

function rig(o: { check?: () => Promise<FolderCheck>; asks?: () => Promise<typeof approved | null>; install?: (grant: string[]) => Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; message: string }> } = {}) {
  vi.useFakeTimers()
  let change: () => void = () => {}
  const events: DevEvent[] = []
  const installs: string[][] = []
  let release: (() => void) | null = null
  const w = watchPluginFolder({
    folder: '/w/p',
    approved,
    check: o.check ?? (async () => clean),
    asks: o.asks ?? (async () => approved),
    install:
      o.install ??
      (async (grant) => {
        installs.push(grant)
        return { ok: true, body: { version: '0.1.0' } }
      }),
    watch: (_folder, onChange) => {
      change = onChange
      return () => {
        change = () => {}
      }
    },
    emit: (e) => void events.push(e),
    now: () => new Date('2026-11-25T10:00:00Z')
  })
  return { w, events, installs, change: () => change(), hold: () => new Promise<void>((r) => (release = r)), release: () => release?.() }
}

describe('watchPluginFolder', () => {
  it('installs once a change has settled, with the grant first approved', async () => {
    const r = rig()
    r.change()
    await vi.advanceTimersByTimeAsync(299)
    expect(r.installs).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await r.w.idle()
    expect(r.installs).toEqual([['projects.read']])
    expect(r.events).toEqual([{ event: 'installed', version: '0.1.0', at: '2026-11-25T10:00:00.000Z' }])
  })

  it('makes one install of a burst of changes', async () => {
    const r = rig()
    for (let i = 0; i < 5; i++) {
      r.change()
      await vi.advanceTimersByTimeAsync(100)
    }
    await vi.advanceTimersByTimeAsync(300)
    await r.w.idle()
    expect(r.installs).toHaveLength(1)
  })

  it('installs once more after a change made while an install was under way, never two at once', async () => {
    let running = 0
    let most = 0
    let gate: (() => void) | null = null
    const r = rig({
      install: async () => {
        running += 1
        most = Math.max(most, running)
        await new Promise<void>((res) => (gate = res))
        running -= 1
        return { ok: true, body: { version: '0.1.0' } }
      }
    })
    r.change()
    await vi.advanceTimersByTimeAsync(300)
    r.change()
    await vi.advanceTimersByTimeAsync(300)
    ;(gate as unknown as () => void)()
    await vi.advanceTimersByTimeAsync(0)
    ;(gate as unknown as () => void)()
    await r.w.idle()
    expect(most).toBe(1)
    expect(r.events.filter((e) => e.event === 'installed')).toHaveLength(2)
  })

  it('does not install a folder with problems, and says what they are', async () => {
    const r = rig({ check: async () => ({ ...clean, problems: [{ code: 'UI_MISSING', message: 'the ui ui/index.html is not a file in the plugin' }] }) })
    r.change()
    await vi.advanceTimersByTimeAsync(300)
    await r.w.idle()
    expect(r.installs).toEqual([])
    expect(r.events).toEqual([{ event: 'problems', problems: [{ code: 'UI_MISSING', message: 'the ui ui/index.html is not a file in the plugin' }] }])
  })

  it('does not install a folder that asks for anything new, and says to run dev again to approve it', async () => {
    const r = rig({ asks: async () => ({ ...approved, permissions: ['projects.read', 'jobs.create'] }) })
    r.change()
    await vi.advanceTimersByTimeAsync(300)
    await r.w.idle()
    expect(r.installs).toEqual([])
    expect(r.events).toEqual([{ event: 'needsApproval', asks: { permissions: ['projects.read', 'jobs.create'], capabilities: [], trust: 'trusted' } }])
  })

  it('says an install was refused, and installs again on the next change', async () => {
    let n = 0
    const r = rig({ install: async () => (++n === 1 ? { ok: false, message: 'the Host is not running' } : { ok: true, body: { version: '0.1.1' } }) })
    r.change()
    await vi.advanceTimersByTimeAsync(300)
    await r.w.idle()
    r.change()
    await vi.advanceTimersByTimeAsync(300)
    await r.w.idle()
    expect(r.events).toEqual([
      { event: 'failed', message: 'the Host is not running' },
      { event: 'installed', version: '0.1.1', at: '2026-11-25T10:00:00.000Z' }
    ])
  })

  it('stops watching on stop', async () => {
    const r = rig()
    r.w.stop()
    r.change()
    await vi.advanceTimersByTimeAsync(1000)
    expect(r.installs).toEqual([])
  })
})

describe('runPluginDev', () => {
  const inspection = { id: 'p', name: 'p', displayName: 'P', version: '0.1.0', trust: 'trusted', permissions: ['projects.read'], capabilities: [] }
  const host = (installed = { status: 200, body: { id: 'p', version: '0.1.0', permissions: ['projects.read'], requested: ['projects.read'], capabilities: [], trust: 'trusted' } }) => {
    const calls: string[] = []
    return {
      calls,
      call: async (cmd: string) => {
        calls.push(cmd)
        return cmd === 'plugins-inspect' ? { status: 200, body: inspection } : installed
      }
    }
  }

  it('asks for approval as install does, installing nothing and watching nothing', async () => {
    const h = host()
    const watch = vi.fn()
    const r = await runPluginDev({ args: { path: '/w/p' }, cwd: '/w', version: '1.6.0', call: h.call, watch, emit: () => {}, onStop: () => {} })
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: expect.stringMatching(/asks for: projects\.read\..*Approve with --yes/) } })
    expect(h.calls).toEqual(['plugins-inspect'])
    expect(watch).not.toHaveBeenCalled()
  })

  it('installs with the approval, says so, watches until stopped, and ends with the last install in place', async () => {
    const h = host()
    const events: DevEvent[] = []
    let stop: () => void = () => {}
    const closed = vi.fn()
    const done = runPluginDev({
      args: { path: '/w/p', yes: true },
      cwd: '/w',
      version: '1.6.0',
      call: h.call,
      watch: () => closed,
      emit: (e) => void events.push(e),
      onStop: (s) => (stop = s),
      now: () => new Date('2026-11-25T10:00:00Z')
    })
    await vi.waitFor(() => expect(events.map((e) => e.event)).toEqual(['installed', 'watching']))
    stop()
    expect(await done).toEqual({ ok: true })
    expect(closed).toHaveBeenCalled()
    expect(h.calls).toEqual(['plugins-inspect', 'plugins-install'])
  })

  it('ends with the Host’s refusal of the first install, watching nothing', async () => {
    const h = host({ status: 409, body: { error: 'the folder changed after it was shown' } } as never)
    const watch = vi.fn()
    const r = await runPluginDev({ args: { path: '/w/p', yes: true }, cwd: '/w', version: '1.6.0', call: h.call, watch, emit: () => {}, onStop: () => {} })
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: 'the folder changed after it was shown' } })
    expect(watch).not.toHaveBeenCalled()
  })
})

describe('devEventLine', () => {
  it('says each event as one sentence', () => {
    expect(devEventLine({ event: 'installed', version: '0.1.1', at: '2026-11-25T10:00:00.000Z' })).toBe('installed 0.1.1 at 2026-11-25T10:00:00.000Z')
    expect(devEventLine({ event: 'watching', folder: '/w/p' })).toBe('watching /w/p; Ctrl+C stops and leaves the last install in place')
    expect(devEventLine({ event: 'problems', problems: [{ code: 'UI_MISSING', message: 'the ui x is not a file in the plugin' }] })).toBe(
      'not installed: UI_MISSING: the ui x is not a file in the plugin'
    )
    expect(devEventLine({ event: 'needsApproval', asks: { permissions: ['jobs.read'], capabilities: [], trust: 'trusted' } })).toBe(
      'not installed: it now asks for jobs.read as trusted code; stop dev and run it again to approve that'
    )
    expect(devEventLine({ event: 'failed', message: 'no Host' })).toBe('not installed: no Host')
  })
})

describe('run.ts runs plugins dev', () => {
  const run = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'run.ts'), 'utf8')
  it('refuses a request id and an agent session, calls the Host once per call, and stops on Ctrl+C', () => {
    const block = run.slice(run.indexOf("if (parsed.cmd === 'plugins-dev') {"))
    expect(block).toMatch(/if \(presented\)\s*fail\(/)
    expect(block).toMatch(/if \(sessionId !== ''\)\s*fail\(\{\s*code: 'PERMISSION_DENIED'/)
    expect(block).toMatch(/const conn = await connectHost\(\{ address, profileDir, app: CLI_VERSION, log: logToStderr \}\)[\s\S]*?finally \{\s*conn\.close\(\)/)
    expect(block).toMatch(/onStop: \(stop\) => \{\s*process\.once\('SIGINT', stop\)\s*process\.once\('SIGTERM', stop\)/)
    expect(block).toMatch(/watch: chokidarWatch/)
  })
})
