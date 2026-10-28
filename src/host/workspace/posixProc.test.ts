import { describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PS_TREE_ARGS,
  btimeOf,
  execText,
  killGroup,
  killPosixTree,
  lateTreeTargets,
  linuxStartTimes,
  macStartTimes,
  parseLstart,
  parsePsTree,
  procStartMs,
  realLinuxProcFs,
  spawnDetached,
  treeKillTargets,
  type LinuxProcFs,
  type ProcRow,
  type Signals
} from './posixProc'

/** A /proc/<pid>/stat line: fields 3 to 21 are filler, field 22 is the start time in ticks. */
const stat = (comm: string, starttime: number): string => {
  const after = ['S', ...Array.from({ length: 18 }, (_, i) => String(i + 4)), String(starttime), '999', '888']
  return `4242 (${comm}) ${after.join(' ')}\n`
}

describe('procStartMs', () => {
  it('reads field 22 as ticks after boot and adds btime', () => {
    expect(procStartMs(stat('Xvfb', 12_345), 1_700_000_000, 100)).toBe(1_700_000_000_000 + 123_450)
  })

  it('finds the fields after the last parenthesis, whatever the command name holds (Review Focus 2)', () => {
    expect(procStartMs(stat('Web Content', 500), 10, 100)).toBe(15_000)
    expect(procStartMs(stat('a) (b', 500), 10, 100)).toBe(15_000)
    expect(procStartMs(stat('électron 앱', 500), 10, 250)).toBe(12_000)
  })

  it('reads nothing from a line that is not a stat line', () => {
    expect(procStartMs('garbage', 10, 100)).toBeNull()
    expect(procStartMs('1 (x) S 2', 10, 100)).toBeNull()
  })
})

describe('btimeOf', () => {
  it('reads the boot time line of /proc/stat', () => {
    expect(btimeOf('cpu 1 2 3\nbtime 1700000000\nprocesses 5\n')).toBe(1_700_000_000)
    expect(btimeOf('cpu 1 2 3\n')).toBeNull()
  })
})

describe('linuxStartTimes', () => {
  const procFs = (files: Record<string, string>): LinuxProcFs & { reads: string[] } => {
    const reads: string[] = []
    return {
      reads,
      readFile: async (p) => {
        reads.push(p)
        if (!(p in files)) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' })
        return files[p]
      },
      ticksPerSec: async () => 100
    }
  }

  it('reads each live pid and leaves a gone one out', async () => {
    const f = procFs({ '/proc/stat': 'btime 1000\n', '/proc/7/stat': stat('sh', 250) })
    expect([...(await linuxStartTimes([7, 8], f)).entries()]).toEqual([[7, 1_002_500]])
  })

  it('reads nothing for no pids, and refuses a /proc/stat with no boot time', async () => {
    const f = procFs({ '/proc/stat': 'cpu 1\n' })
    expect((await linuxStartTimes([], f)).size).toBe(0)
    expect(f.reads).toEqual([])
    await expect(linuxStartTimes([7], f)).rejects.toThrow('no btime')
  })
})

describe('parseLstart', () => {
  it('reads ps lstart under LC_ALL=C, a one digit day padded with a space, as local time (Review Focus 5)', () => {
    expect(parseLstart('Sat Sep 27 10:11:12 2026')).toBe(new Date(2026, 8, 27, 10, 11, 12).getTime())
    expect(parseLstart('Mon Sep  7 01:02:03 2026\n')).toBe(new Date(2026, 8, 7, 1, 2, 3).getTime())
    expect(parseLstart('sam 27 sep 10:11:12 2026')).toBeNull()
    expect(parseLstart('')).toBeNull()
  })
})

describe('macStartTimes', () => {
  it('asks ps once, under LC_ALL=C, for every pid', async () => {
    const exec = vi.fn(async () => '  100 Sat Sep 27 10:11:12 2026\n  200 Mon Sep  7 01:02:03 2026\n')
    const r = await macStartTimes([100, 200], exec)
    expect([...r.entries()]).toEqual([
      [100, new Date(2026, 8, 27, 10, 11, 12).getTime()],
      [200, new Date(2026, 8, 7, 1, 2, 3).getTime()]
    ])
    expect(exec).toHaveBeenCalledWith('env', ['LC_ALL=C', 'ps', '-o', 'pid=,lstart=', '-p', '100,200'])
  })

  it('still reads the pids ps listed when it exits 1 for a gone one', async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error('Command failed'), { code: 1, stdout: '  100 Sat Sep 27 10:11:12 2026\n' })
    })
    expect([...(await macStartTimes([100, 300], exec)).keys()]).toEqual([100])
  })

  it('rejects when ps fails for a reason other than "no such pid" (code 1): an ENOENT, a timeout, a signal', async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error('spawn env ENOENT'), { code: 'ENOENT' })
    })
    await expect(macStartTimes([100], exec)).rejects.toThrow('ENOENT')
  })
})

describe('killGroup', () => {
  const fakeSignals = (o: { leader?: boolean; diesOnTerm?: boolean; gone?: boolean; eperm?: boolean } = {}) => {
    const sent: Array<[number, NodeJS.Signals | 0]> = []
    let alive = o.gone !== true
    const fail = (code: string): never => {
      throw Object.assign(new Error(`kill ${code}`), { code })
    }
    const s: Signals = {
      kill: (pid, sig) => {
        sent.push([pid, sig])
        if (o.eperm) fail('EPERM')
        if (!alive) fail('ESRCH')
        if (pid < 0 && o.leader === false) fail('ESRCH')
        if (sig === 'SIGTERM' && o.diesOnTerm !== false) alive = false
        if (sig === 'SIGKILL') alive = false
      },
      sleep: async () => {}
    }
    return { s, sent }
  }

  it('sends SIGTERM to the group and stops once it is gone', async () => {
    const f = fakeSignals()
    await killGroup(4242, f.s)
    expect(f.sent).toEqual([[-4242, 'SIGTERM'], [-4242, 0]])
  })

  it('sends SIGKILL once the grace has passed and the group is still there', async () => {
    const f = fakeSignals({ diesOnTerm: false })
    await killGroup(4242, f.s, 300)
    expect(f.sent).toEqual([[-4242, 'SIGTERM'], [-4242, 0], [-4242, 0], [-4242, 0], [-4242, 'SIGKILL']])
  })

  it('signals the pid alone when it leads no group', async () => {
    const f = fakeSignals({ leader: false })
    await killGroup(4242, f.s)
    expect(f.sent).toEqual([[-4242, 'SIGTERM'], [4242, 'SIGTERM'], [4242, 0]])
  })

  it('a group already gone is not a failure', async () => {
    const f = fakeSignals({ gone: true })
    await expect(killGroup(4242, f.s)).resolves.toBeUndefined()
    expect(f.sent).toEqual([[-4242, 'SIGTERM'], [4242, 'SIGTERM']])
  })

  it('passes on a failure that is not ESRCH', async () => {
    await expect(killGroup(4242, fakeSignals({ eperm: true }).s)).rejects.toThrow('EPERM')
  })

  it("never signals pid 0, 1 or a negative number, which would reach the Host's own group or every process (Review Focus 3)", async () => {
    const f = fakeSignals()
    for (const pid of [0, 1, -1, -4242, 1.5, Number.NaN]) await expect(killGroup(pid, f.s)).rejects.toThrow('not a pid')
    expect(f.sent).toEqual([])
  })
})

const row = (pid: number, ppid: number, pgid: number): ProcRow => ({ pid, ppid, pgid })
/** The Host (500, leading its own group) started a workspace app through sh (1000), detached, so sh
 *  leads a group of its own; Electron (1001) and its helper (1002) stay in it. */
const BASE = [row(1, 0, 1), row(400, 1, 400), row(500, 400, 500), row(1000, 500, 1000), row(1001, 1000, 1000), row(1002, 1001, 1000)]

describe('parsePsTree', () => {
  it('reads pid, ppid and pgid columns, padded or not, and skips anything else', () => {
    expect(parsePsTree('    1     0     1\n  500   400   500\nPID PPID PGID\n\n12 3\n7 1 7 9\n')).toEqual([row(1, 0, 1), row(500, 400, 500)])
  })
})

describe('treeKillTargets', () => {
  it('ends the root group, and the group of a child it started detached (setsid), which the root group does not hold', () => {
    const rows = [...BASE, row(1003, 1001, 1003), row(1004, 1003, 1003)]
    expect(treeKillTargets(rows, 1000, 500)).toEqual({ groups: [1000, 1003], pids: [] })
  })

  it('still reaches a member of the root group whose parent exited, and what that member started detached', () => {
    const rows = [...BASE, row(1005, 1, 1000), row(1006, 1005, 1006)]
    expect(treeKillTargets(rows, 1000, 500)).toEqual({ groups: [1000, 1006], pids: [] })
  })

  it('cannot find a detached grandchild whose parent exited before the snapshot: no ppid or group leads to it', () => {
    const rows = [...BASE, row(1007, 1, 1007)]
    expect(treeKillTargets(rows, 1000, 500)).toEqual({ groups: [1000], pids: [] })
  })

  it('ends the root group by its number when the root itself is gone and members of it are left', () => {
    const rows = [row(1, 0, 1), row(500, 400, 500), row(3001, 1, 3000), row(3002, 3001, 3002)]
    expect(treeKillTargets(rows, 3000, 500)).toEqual({ groups: [3000, 3002], pids: [] })
  })

  it("never signals the Host's pid or its group: a descendant in the Host's group is ended by its pid alone", () => {
    // A root that was not detached: it and its child stay in the group the Host belongs to (400).
    const rows = [row(1, 0, 1), row(400, 1, 400), row(500, 400, 400), row(2000, 500, 400), row(2001, 2000, 400), row(2002, 2001, 2002)]
    expect(treeKillTargets(rows, 2000, 500)).toEqual({ groups: [2002], pids: [2000, 2001] })
  })

  it("does not walk the Host's group when a tree process leads it: the Host's other children stay out", () => {
    // The Host (500) does not lead its group; root 400 does, and brings in no member of it.
    const rows = [row(1, 0, 1), row(400, 1, 400), row(500, 400, 400), row(2000, 500, 400), row(2001, 2000, 400), row(2002, 2001, 2002)]
    expect(treeKillTargets(rows, 400, 500)).toEqual({ groups: [], pids: [400] })
    const flat = [row(300, 1, 300), row(500, 300, 300), row(600, 500, 300)]
    expect(treeKillTargets(flat, 300, 500)).toEqual({ groups: [], pids: [300] })
  })

  it('never reaches the Host, or anything it started, from a root above it', () => {
    const rows = [...BASE, row(1003, 1001, 1003)]
    expect(treeKillTargets(rows, 400, 500)).toEqual({ groups: [400], pids: [] })
  })

  it('never signals pid 0 or 1, or a group either one leads, and refuses them or the Host as the root', () => {
    const rows = [row(0, 0, 0), row(1, 0, 1), row(500, 1, 500), row(4000, 1, 4000), row(4001, 4000, 1), row(4002, 4000, 0), row(1, 4000, 1)]
    expect(treeKillTargets(rows, 4000, 500)).toEqual({ groups: [4000], pids: [4001, 4002] })
    for (const root of [0, 1, 500]) expect(treeKillTargets(rows, root, 500)).toEqual({ groups: [], pids: [] })
  })
})

describe('lateTreeTargets', () => {
  // The first listing: the launch, and the Host Electron (1001) started detached (1003).
  const BEFORE = [...BASE, row(1003, 1001, 1003)]

  it('adds what a tree process still alive started during the grace: a setsid child, its own child, and nothing it had already', () => {
    // Electron outlived its SIGTERM and started a new Host (1010, setsid) with a child of its own (1011);
    // the helper (1002) and the first Host (1003) are gone.
    const after = [row(1, 0, 1), row(400, 1, 400), row(500, 400, 500), row(1000, 500, 1000), row(1001, 1000, 1000), row(1010, 1001, 1010), row(1011, 1010, 1010)]
    expect(lateTreeTargets(BEFORE, after, 1000, 500)).toEqual({ groups: [1010], pids: [] })
  })

  it('leaves alone a new process whose parent is not in the tree, and an orphan whose parent in it is gone', () => {
    // The Host (500) and the app (400) started processes of their own; 1030 was started by the first
    // Host (1003), which is gone, so nothing in the tree leads to it any more.
    const after = [row(1, 0, 1), row(400, 1, 400), row(500, 400, 500), row(1000, 500, 1000), row(1001, 1000, 1000), row(1020, 500, 1020), row(1021, 400, 1021), row(1030, 1, 1030)]
    expect(lateTreeTargets(BEFORE, after, 1000, 500)).toEqual({ groups: [], pids: [] })
  })

  it('adds no pid target for a member of a group the first listing already ends, once that group leader is gone', () => {
    // sh (1000) is gone; Electron (1001) is still in its group, which the first listing ends as a whole.
    const after = [row(1, 0, 1), row(500, 400, 500), row(1001, 1000, 1000)]
    expect(lateTreeTargets(BEFORE, after, 1000, 500)).toEqual({ groups: [], pids: [] })
  })

  it('adds the group of a tree process that left its group for one of its own after the first listing', () => {
    const after = [row(1, 0, 1), row(500, 400, 500), row(1000, 500, 1000), row(1001, 1000, 1001), row(1002, 1001, 1001)]
    expect(lateTreeTargets(BEFORE, after, 1000, 500)).toEqual({ groups: [1001], pids: [] })
  })

  it('does not count a first-tree pid reused by an unrelated process: its parent and its group both differ now', () => {
    // The helper (1002) is gone and 1002 is a stranger now, with a child of its own (1040).
    const after = [row(1, 0, 1), row(500, 400, 500), row(1000, 500, 1000), row(1001, 1000, 1000), row(1002, 700, 1002), row(1040, 1002, 1002)]
    expect(lateTreeTargets(BEFORE, after, 1000, 500)).toEqual({ groups: [], pids: [] })
  })

  it('still counts a first-tree process whose parent died during the grace: the parent changed but the group is the same', () => {
    // Electron (1001) is gone; the helper (1002) went to parent 1 and kept group 1000, and started 1041 detached.
    const after = [row(1, 0, 1), row(500, 400, 500), row(1002, 1, 1000), row(1041, 1002, 1041)]
    expect(lateTreeTargets(BEFORE, after, 1000, 500)).toEqual({ groups: [1041], pids: [] })
  })

  it("keeps the guards: never pid 0 or 1, the Host's pid or its group, and nothing for a root that is one of them", () => {
    // A new child in group 1 or 0 is ended by its pid alone; a row claiming pid 1 or the Host as a new
    // child of Electron is never taken.
    const after = [row(0, 0, 0), row(1, 1001, 1), row(500, 1001, 500), row(1000, 500, 1000), row(1001, 1000, 1000), row(1012, 1001, 1), row(1013, 1001, 0)]
    expect(lateTreeTargets(BEFORE, after, 1000, 500)).toEqual({ groups: [], pids: [1012, 1013] })
    for (const root of [0, 1, 500]) expect(lateTreeTargets(BEFORE, after, root, 500)).toEqual({ groups: [], pids: [] })
  })
})

describe('killPosixTree', () => {
  /** A process table: `ps` answers it (the first listing with `rows`, any later one with what is still
   *  alive), and signals end its processes. A group signal reaches every member; EPERM only when it
   *  reaches no process it may signal, as kill(2) says. `later` start at the first wait of the grace. */
  const table = (rows: ProcRow[], o: { stubborn?: number[]; eperm?: number[]; gone?: number[]; later?: ProcRow[] } = {}) => {
    const live = new Map(rows.filter((r) => !o.gone?.includes(r.pid)).map((r) => [r.pid, r]))
    const sent: Array<[number, NodeJS.Signals | 0]> = []
    const fail = (code: string): never => {
      throw Object.assign(new Error(`kill ${code}`), { code })
    }
    let started = false
    const s: Signals = {
      kill: (target, sig) => {
        sent.push([target, sig])
        const hit = target < 0 ? [...live.values()].filter((r) => r.pgid === -target) : [live.get(target)].filter((r): r is ProcRow => r !== undefined)
        if (hit.length === 0) fail('ESRCH')
        if (hit.every((r) => o.eperm?.includes(r.pid))) fail('EPERM')
        for (const r of hit) {
          if (o.eperm?.includes(r.pid)) continue
          if (sig === 'SIGKILL' || (sig === 'SIGTERM' && !o.stubborn?.includes(r.pid))) live.delete(r.pid)
        }
      },
      sleep: async () => {
        if (started) return
        started = true
        for (const r of o.later ?? []) live.set(r.pid, r)
      }
    }
    const text = (list: ProcRow[]): string => list.map((r) => `${String(r.pid).padStart(5)} ${String(r.ppid).padStart(5)} ${String(r.pgid).padStart(5)}`).join('\n') + '\n'
    const exec = vi.fn(async (_file: string, _args: string[]) => text(exec.mock.calls.length === 1 ? rows : [...live.values()]))
    return { s, sent, exec, live }
  }

  it('lists the table with ps under LC_ALL=C, ends every target with SIGTERM, and SIGKILLs what is left after the grace', async () => {
    const t = table([...BASE, row(1003, 1001, 1003), row(1004, 1003, 1003)], { stubborn: [1004] })
    await killPosixTree(1000, { exec: t.exec, signals: t.s, hostPid: 500, graceMs: 200 })
    // Once before any signal, and once more before SIGKILL, since something outlived the grace.
    expect(t.exec.mock.calls).toEqual([
      ['env', PS_TREE_ARGS],
      ['env', PS_TREE_ARGS]
    ])
    expect(PS_TREE_ARGS).toEqual(['LC_ALL=C', 'ps', '-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid='])
    expect(t.sent).toEqual([
      [-1000, 'SIGTERM'],
      [-1003, 'SIGTERM'],
      [-1000, 0],
      [-1003, 0],
      [-1003, 0],
      [-1003, 'SIGKILL']
    ])
    expect([...t.live.keys()]).toEqual([1, 400, 500])
  })

  it('a tree already gone, wholly or in part, is not a failure', async () => {
    const empty = table([row(1, 0, 1), row(500, 400, 500)])
    await expect(killPosixTree(1000, { exec: empty.exec, signals: empty.s, hostPid: 500 })).resolves.toBeUndefined()
    expect(empty.sent).toEqual([])
    const raced = table([...BASE, row(1003, 1001, 1003)], { gone: [1003] })
    await expect(killPosixTree(1000, { exec: raced.exec, signals: raced.s, hostPid: 500 })).resolves.toBeUndefined()
    expect(raced.sent).toEqual([[-1000, 'SIGTERM'], [-1003, 'SIGTERM'], [-1000, 0]])
    // Nothing outlived the grace, so there is no second listing.
    expect(raced.exec).toHaveBeenCalledTimes(1)
  })

  it('lists again before SIGKILL and ends what a process still alive started during the grace (a dev app starting its Host again)', async () => {
    // Electron (1001) outlives its SIGTERM and starts a new Host (1010) in a session of its own.
    const t = table(BASE, { stubborn: [1001, 1010], later: [row(1010, 1001, 1010), row(1020, 500, 1020)] })
    await killPosixTree(1000, { exec: t.exec, signals: t.s, hostPid: 500, graceMs: 200 })
    expect(t.exec).toHaveBeenCalledTimes(2)
    expect(t.sent).toEqual([
      [-1000, 'SIGTERM'],
      [-1000, 0],
      [-1000, 0],
      [-1000, 'SIGKILL'],
      [-1010, 'SIGKILL']
    ])
    // What the Host itself started meanwhile (1020) is not the tree's, and is left alone.
    expect([...t.live.keys()]).toEqual([1, 400, 500, 1020])
  })

  it('a second listing that fails still SIGKILLs what is left, then says the tree could not be listed again', async () => {
    const t = table(BASE, { stubborn: [1001] })
    t.exec.mockImplementationOnce(t.exec.getMockImplementation()!).mockRejectedValueOnce(new Error('ps timed out'))
    await expect(killPosixTree(1000, { exec: t.exec, signals: t.s, hostPid: 500, graceMs: 100 })).rejects.toThrow('could not be listed again before SIGKILL: ps timed out')
    expect(t.sent.at(-1)).toEqual([-1000, 'SIGKILL'])
    expect([...t.live.keys()]).toEqual([1, 400, 500])
  })

  it('a ps that fails still ends the root group, as before, and then says the rest could not be listed', async () => {
    const t = table(BASE)
    t.exec.mockRejectedValue(Object.assign(new Error('spawn env ENOENT'), { code: 'ENOENT' }))
    await expect(killPosixTree(1000, { exec: t.exec, signals: t.s, hostPid: 500 })).rejects.toThrow('could not be listed: spawn env ENOENT')
    expect(t.sent[0]).toEqual([-1000, 'SIGTERM'])
    expect([...t.live.keys()]).toEqual([1, 400, 500])
  })

  it('a target it may not signal does not keep the rest of the tree alive; the failure is passed on afterwards', async () => {
    const t = table([...BASE, row(1003, 1001, 1003)], { eperm: [1003] })
    await expect(killPosixTree(1000, { exec: t.exec, signals: t.s, hostPid: 500 })).rejects.toThrow('EPERM')
    expect(t.sent.slice(0, 2)).toEqual([[-1000, 'SIGTERM'], [-1003, 'SIGTERM']])
    expect([...t.live.keys()]).toEqual([1, 400, 500, 1003])
  })

  it("refuses pid 0, 1, a negative, a fraction and the Host's own pid before it lists or signals anything", async () => {
    const t = table(BASE)
    for (const pid of [0, 1, -1, -4242, 1.5, Number.NaN, 500]) await expect(killPosixTree(pid, { exec: t.exec, signals: t.s, hostPid: 500 })).rejects.toThrow('not a pid')
    expect(t.exec).not.toHaveBeenCalled()
    expect(t.sent).toEqual([])
  })
})

describe.runIf(process.platform !== 'win32')('killPosixTree on this machine', () => {
  it('ends a child the root started detached, in a session of its own, which the root group kill leaves running', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-tree-'))
    const pidFile = path.join(dir, 'child.pid')
    const script =
      "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); " +
      "require('node:fs').writeFileSync(process.argv[1], String(c.pid)); c.unref(); setInterval(() => {}, 1000)"
    const p = spawnDetached(process.execPath, ['-e', script, '--', pidFile], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })
    let child = 0
    try {
      for (let i = 0; i < 100 && !child; i++) {
        child = Number(await fs.readFile(pidFile, 'utf8').catch(() => '')) || 0
        if (!child) await new Promise((r) => setTimeout(r, 100))
      }
      expect(child).toBeGreaterThan(1)
      const exited = new Promise<string>((r) => p.onExit(r))
      await killPosixTree(p.pid!)
      expect(await exited).toBe('exited SIGTERM')
      // An orphan is reaped by whoever adopted it, a moment after it dies.
      const gone = (): boolean => {
        try {
          process.kill(child, 0)
          return false
        } catch {
          return true
        }
      }
      for (let i = 0; i < 50 && !gone(); i++) await new Promise((r) => setTimeout(r, 100))
      expect(gone()).toBe(true)
    } finally {
      for (const pid of [child, p.pid ?? 0]) {
        try {
          if (pid > 1) process.kill(pid, 'SIGKILL')
        } catch {
          /* gone */
        }
      }
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it(
    'ends a detached child the root starts during the grace, after its SIGTERM, as a dev app starting its Host again would',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-tree-late-'))
      const readyFile = path.join(dir, 'ready')
      const pidFile = path.join(dir, 'child.pid')
      // The root outlives SIGTERM and starts the child 500 ms after it, inside the 2 s grace.
      const script =
        "const fs = require('node:fs'); process.on('SIGTERM', () => setTimeout(() => { " +
        "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); " +
        'fs.writeFileSync(process.argv[2], String(c.pid)); c.unref() }, 500)); ' +
        "fs.writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)"
      const p = spawnDetached(process.execPath, ['-e', script, '--', readyFile, pidFile], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })
      let child = 0
      try {
        for (let i = 0; i < 100 && !(await fs.readFile(readyFile, 'utf8').catch(() => '')); i++) await new Promise((r) => setTimeout(r, 100))
        const exited = new Promise<string>((r) => p.onExit(r))
        await killPosixTree(p.pid!)
        expect(await exited).toBe('exited SIGKILL')
        child = Number(await fs.readFile(pidFile, 'utf8').catch(() => '')) || 0
        expect(child).toBeGreaterThan(1)
        const gone = (): boolean => {
          try {
            process.kill(child, 0)
            return false
          } catch {
            return true
          }
        }
        for (let i = 0; i < 50 && !gone(); i++) await new Promise((r) => setTimeout(r, 100))
        expect(gone()).toBe(true)
      } finally {
        for (const pid of [child, p.pid ?? 0]) {
          try {
            if (pid > 1) process.kill(pid, 'SIGKILL')
          } catch {
            /* gone */
          }
        }
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
    20_000
  )
})

describe.runIf(process.platform !== 'win32')('spawnDetached, killGroup and the start times on this machine', () => {
  it('starts a group leader and ends its whole group, the background child included', async () => {
    const p = spawnDetached('sh', ['-c', 'sleep 30 & sleep 30'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })
    expect(p.pid).toBeGreaterThan(1)
    const exited = new Promise<string>((r) => p.onExit(r))
    await killGroup(p.pid!)
    expect(await exited).toBe('exited SIGTERM')
    expect(() => process.kill(-p.pid!, 0)).toThrow()
  })

  it('reports a spawn that cannot start as an exit, never as an unhandled error', async () => {
    const p = spawnDetached('astera-no-such-program', [], { env: {} })
    expect(await new Promise<string>((r) => p.onExit(r))).toContain('could not start')
  })

  it("reads this process's own start time within a few seconds of what Node says", async () => {
    const t =
      process.platform === 'linux'
        ? (await linuxStartTimes([process.pid], realLinuxProcFs(execText))).get(process.pid)
        : (await macStartTimes([process.pid], execText)).get(process.pid)
    expect(Math.abs(t! - (Date.now() - process.uptime() * 1000))).toBeLessThan(3_000)
  })
})

describe('spawnDetached: the ready pipe', () => {
  it('reads what the process writes to fd 3 when asked for a ready pipe (Xvfb -displayfd), and has none otherwise', async () => {
    const write = 'require("fs").writeSync(3, "90" + String.fromCharCode(10))'
    const p = spawnDetached(process.execPath, ['-e', write], { env: { PATH: process.env.PATH ?? '' }, readyFd: true })
    expect(await new Promise<string>((r) => p.onExit(r))).toBe('exited 0')
    expect(p.readyText?.()).toBe('90\n')
    const q = spawnDetached(process.execPath, ['-e', ''], { env: { PATH: process.env.PATH ?? '' } })
    await new Promise<string>((r) => q.onExit(r))
    expect(q.readyText?.() ?? '').toBe('')
  })
})
