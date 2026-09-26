import { describe, it, expect } from 'vitest'
import { createConhostReaper, reapWindowsConsoleHosts, CONHOST_REAP_DEBOUNCE_MS, type ConhostReapQuery, type ConhostReapResult } from './conhostReaper'

// Leftovers Task 5 (S3-2): node-pty 1.1.0 leaks one conhost.exe (or OpenConsole.exe) for every pty that
// ends by itself, because its native exit thread never calls ClosePseudoConsole. Measured on Windows 11
// (2026-09-26): after `cmd /c exit 0` in a pty, a conhost.exe stays a child of the spawning process for as
// long as that process lives, and killing it costs the process and its next pty nothing. The Host
// lives for days, so it reaps them when it holds no live pty. Every process here is a fake.

const HOST = 4000

const rig = (o: { platform?: NodeJS.Platform; reaped?: () => Promise<ConhostReapResult[]> } = {}) => {
  let clock = 1_000
  let live = 0
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = []
  const asked: ConhostReapQuery[] = []
  const logs: string[] = []
  const r = createConhostReaper({
    platform: o.platform ?? 'win32',
    hostPid: HOST,
    livePtys: () => live,
    reapChildren: async (q) => {
      asked.push(q)
      return o.reaped ? o.reaped() : []
    },
    log: (m) => logs.push(m),
    now: () => clock,
    after: (ms, fn) => {
      const t = { ms, fn, cancelled: false }
      timers.push(t)
      return () => {
        t.cancelled = true
      }
    }
  })
  return {
    r,
    asked,
    logs,
    setClock: (t: number) => {
      clock = t
    },
    setLive: (n: number) => {
      live = n
    },
    pending: () => timers.filter((t) => !t.cancelled),
    /** Fires every armed timer, then lets the enumeration's promise settle. */
    fire: async () => {
      for (const t of timers.splice(0)) if (!t.cancelled) t.fn()
      await new Promise((res) => setTimeout(res, 0))
    }
  }
}


describe('createConhostReaper', () => {
  it('asks to reap the Host’s own console hosts made between its start and the last spawn, after the debounce', async () => {
    const h = rig({ reaped: async () => [{ pid: 11, name: 'conhost.exe' }, { pid: 12, name: 'OpenConsole.exe' }] })
    h.setLive(1)
    h.setClock(3_000)
    h.r.spawned()
    h.setLive(0)
    h.r.exited()
    expect(h.asked).toEqual([]) // debounced
    expect(h.pending().map((t) => t.ms)).toEqual([CONHOST_REAP_DEBOUNCE_MS])
    await h.fire()
    expect(h.asked).toEqual([{ parentPid: HOST, createdFrom: 1_000, createdTo: 3_000 }])
    expect(h.logs.join('\n')).toMatch(/reaped 2/)
  })

  it('reaps nothing when a pty went live before the debounce ran out', async () => {
    const h = rig({ reaped: async () => [{ pid: 11, name: 'conhost.exe' }] })
    h.setClock(3_000)
    h.r.spawned()
    h.r.exited()
    h.setLive(1)
    await h.fire()
    expect(h.asked).toEqual([])
  })

  it('does not arm while a pty is still live, and a spawn cancels an armed reap', async () => {
    const h = rig()
    h.setClock(3_000)
    h.r.spawned()
    h.setLive(1)
    h.r.exited()
    expect(h.pending()).toHaveLength(0)
    h.setLive(0)
    h.r.exited()
    h.r.exited()
    expect(h.pending()).toHaveLength(1) // debounced: one timer for two exits
    h.r.spawned()
    expect(h.pending()).toHaveLength(0)
    await h.fire()
    expect(h.asked).toEqual([])
  })

  it('does nothing before the first spawn: there is no leaked console host yet', async () => {
    const h = rig()
    h.r.exited()
    await h.fire()
    expect(h.asked).toEqual([])
  })

  it('is a no-op off Windows', async () => {
    const h = rig({ platform: 'linux' })
    h.setClock(3_000)
    h.r.spawned()
    h.r.exited()
    await h.fire()
    expect(h.asked).toEqual([])
    expect(h.pending()).toHaveLength(0)
  })

  it('logs a failed reap and a console host that could not be ended, and goes on', async () => {
    const failing = rig({ reaped: async () => Promise.reject(new Error('powershell missing')) })
    failing.setClock(3_000)
    failing.r.spawned()
    failing.r.exited()
    await failing.fire()
    expect(failing.logs.join('\n')).toMatch(/powershell missing/)

    const h = rig({ reaped: async () => [{ pid: 11, name: 'conhost.exe', error: 'Access is denied' }, { pid: 12, name: 'conhost.exe' }] })
    h.setClock(3_000)
    h.r.spawned()
    h.r.exited()
    await h.fire()
    expect(h.logs.join('\n')).toMatch(/conhost\.exe 11 could not be ended: Access is denied/)
    expect(h.logs.join('\n')).toMatch(/reaped 1/)
  })

  it('stops after dispose', async () => {
    const h = rig()
    h.setClock(3_000)
    h.r.spawned()
    h.r.exited()
    h.r.dispose()
    await h.fire()
    expect(h.asked).toEqual([])
  })
})

// Final review M3: the check and the kill run in one PowerShell pipeline, so the pid that was checked
// is the pid that is ended.
describe('reapWindowsConsoleHosts', () => {
  it('filters by parent, name and creation window and stops each match in the same pipeline, and reads what it ended', async () => {
    const asked: string[][] = []
    const results = await reapWindowsConsoleHosts({ parentPid: 4000, createdFrom: 1_000, createdTo: 3_000 }, async (file, args) => {
      asked.push([file, ...args])
      return 'ok|11|conhost.exe\r\n\r\njunk line\r\nfail|12|OpenConsole.exe|Access is denied\r\nok|13|cmd.exe\r\nok|x|conhost.exe\r\n'
    })
    expect(asked).toHaveLength(1)
    expect(asked[0][0]).toBe('powershell.exe')
    const script = asked[0][asked[0].length - 1]
    expect(script).toContain('ParentProcessId=4000')
    expect(script).toMatch(/Where-Object \{[^}]*ParentProcessId -eq 4000[^}]*conhost\|openconsole[^}]*-ge 1000[^}]*-le 3000[^}]*\} \| ForEach-Object \{[^]*Stop-Process -Id \$p\.ProcessId/)
    expect(results).toEqual([
      { pid: 11, name: 'conhost.exe' },
      { pid: 12, name: 'OpenConsole.exe', error: 'Access is denied' }
    ])
  })

  it('refuses a pid or a window that is not an integer rather than build a script from it', async () => {
    await expect(reapWindowsConsoleHosts({ parentPid: -1, createdFrom: 0, createdTo: 1 }, async () => '')).rejects.toThrow()
    await expect(reapWindowsConsoleHosts({ parentPid: 4000, createdFrom: 0, createdTo: Number.NaN }, async () => '')).rejects.toThrow()
  })
})
