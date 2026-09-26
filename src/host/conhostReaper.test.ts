import { describe, it, expect } from 'vitest'
import { createConhostReaper, listWindowsChildren, CONHOST_REAP_DEBOUNCE_MS, type ConhostChild } from './conhostReaper'

// Leftovers Task 5 (S3-2): node-pty 1.1.0 leaks one conhost.exe (or OpenConsole.exe) for every pty that
// ends by itself, because its native exit thread never calls ClosePseudoConsole. Measured on Windows 11
// (2026-09-26): after `cmd /c exit 0` in a pty, a conhost.exe stays a child of the spawning process for as
// long as that process lives, and killing it costs the process and its next pty nothing. The Host
// lives for days, so it reaps them when it holds no live pty. Every process here is a fake.

const HOST = 4000

const rig = (o: { platform?: NodeJS.Platform; children?: () => Promise<ConhostChild[]>; killThrows?: number } = {}) => {
  let clock = 1_000
  let live = 0
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = []
  const listed: number[] = []
  const killed: number[] = []
  const logs: string[] = []
  const r = createConhostReaper({
    platform: o.platform ?? 'win32',
    hostPid: HOST,
    livePtys: () => live,
    listChildren: async (pid) => {
      listed.push(pid)
      return o.children ? o.children() : []
    },
    kill: (pid) => {
      if (pid === o.killThrows) throw new Error('ESRCH')
      killed.push(pid)
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
    listed,
    killed,
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

const child = (pid: number, name: string, createdAt: number, parentPid = HOST): ConhostChild => ({ pid, parentPid, name, createdAt })

describe('createConhostReaper', () => {
  it('reaps only the Host’s own conhost and OpenConsole children made between its start and the last spawn', async () => {
    const h = rig({
      children: async () => [
        child(11, 'conhost.exe', 2_000), // a pty's, leaked
        child(12, 'OpenConsole.exe', 2_500), // the bundled ConPTY's, leaked
        child(13, 'conhost.exe', 500), // made before this Host's reaper existed: the Host's own console
        child(14, 'conhost.exe', 3_500), // made after the last spawn
        child(15, 'cmd.exe', 2_000), // not a console host
        child(16, 'conhost.exe', 2_000, 999) // not the Host's child
      ]
    })
    h.setLive(1)
    h.setClock(3_000)
    h.r.spawned()
    h.setLive(0)
    h.r.exited()
    expect(h.listed).toEqual([]) // debounced
    expect(h.pending().map((t) => t.ms)).toEqual([CONHOST_REAP_DEBOUNCE_MS])
    await h.fire()
    expect(h.listed).toEqual([HOST])
    expect(h.killed).toEqual([11, 12])
    expect(h.logs.join('\n')).toMatch(/reaped 2/)
  })

  it('kills nothing when a pty went live while the children were being listed', async () => {
    let h: ReturnType<typeof rig> | null = null
    h = rig({
      children: async () => {
        h!.setLive(1)
        return [child(11, 'conhost.exe', 2_000)]
      }
    })
    h.setClock(3_000)
    h.r.spawned()
    h.r.exited()
    await h.fire()
    expect(h.listed).toEqual([HOST])
    expect(h.killed).toEqual([])
  })

  it('does not arm while a pty is still live, and a spawn cancels an armed reap', async () => {
    const h = rig({ children: async () => [child(11, 'conhost.exe', 2_000)] })
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
    expect(h.listed).toEqual([])
  })

  it('does nothing before the first spawn: there is no leaked console host yet', async () => {
    const h = rig({ children: async () => [child(11, 'conhost.exe', 2_000)] })
    h.r.exited()
    await h.fire()
    expect(h.listed).toEqual([])
  })

  it('is a no-op off Windows', async () => {
    const h = rig({ platform: 'linux', children: async () => [child(11, 'conhost.exe', 2_000)] })
    h.setClock(3_000)
    h.r.spawned()
    h.r.exited()
    await h.fire()
    expect(h.listed).toEqual([])
    expect(h.pending()).toHaveLength(0)
  })

  it('logs a failed listing and a failed kill, and goes on', async () => {
    const failing = rig({ children: async () => Promise.reject(new Error('powershell missing')) })
    failing.setClock(3_000)
    failing.r.spawned()
    failing.r.exited()
    await failing.fire()
    expect(failing.logs.join('\n')).toMatch(/powershell missing/)

    const h = rig({ children: async () => [child(11, 'conhost.exe', 2_000), child(12, 'conhost.exe', 2_100)], killThrows: 11 })
    h.setClock(3_000)
    h.r.spawned()
    h.r.exited()
    await h.fire()
    expect(h.killed).toEqual([12])
    expect(h.logs.join('\n')).toMatch(/ESRCH/)
  })

  it('stops after dispose', async () => {
    const h = rig({ children: async () => [child(11, 'conhost.exe', 2_000)] })
    h.setClock(3_000)
    h.r.spawned()
    h.r.exited()
    h.r.dispose()
    await h.fire()
    expect(h.listed).toEqual([])
  })
})

describe('listWindowsChildren', () => {
  it('asks for the children of one pid and reads pid, parent, name and creation time', async () => {
    const asked: string[][] = []
    const rows = await listWindowsChildren(4000, async (file, args) => {
      asked.push([file, ...args])
      return '11|4000|conhost.exe|1790397219765\r\n\r\njunk line\r\n12|4000|OpenConsole.exe|1790397219800\r\n13|4000|x.exe|notanumber\r\n'
    })
    expect(asked[0][0]).toBe('powershell.exe')
    expect(asked[0].join(' ')).toContain('ParentProcessId=4000')
    expect(rows).toEqual([
      { pid: 11, parentPid: 4000, name: 'conhost.exe', createdAt: 1790397219765 },
      { pid: 12, parentPid: 4000, name: 'OpenConsole.exe', createdAt: 1790397219800 }
    ])
  })

  it('refuses a pid that is not a positive integer rather than build a filter from it', async () => {
    await expect(listWindowsChildren(-1, async () => '')).rejects.toThrow()
  })
})
