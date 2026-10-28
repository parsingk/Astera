import { describe, it, expect, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DeskHandle } from '../../core/workspace/helpers'
import { DESK_READY_MS } from '../../core/workspace/protocol'
import {
  BUNDLE_ARGS_PS,
  BUNDLE_LIST_PS,
  MAC_BACKGROUND_FLAGS,
  bundleCommand,
  createMacDesks,
  hasTag,
  macRefusal,
  pickTagged,
  realMacDeskDeps,
  recentStarts,
  type MacDeskDeps
} from './deskMac'

const at = (d: number, h: number, m: number, s: number): number => new Date(2026, 8, d, h, m, s).getTime()
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n: number): string => String(n).padStart(2, '0')
/** What `ps -o lstart=` prints under LC_ALL=C for a local time. */
const lstart = (ms: number): string => {
  const t = new Date(ms)
  return `${DAYS[t.getDay()]} ${MONTHS[t.getMonth()]} ${String(t.getDate()).padStart(2)} ${two(t.getHours())}:${two(t.getMinutes())}:${two(t.getSeconds())} ${t.getFullYear()}`
}

interface Row {
  pid: number
  startedAt: number
  args: string
  /** Not in any ps output before the clock reaches this. */
  from?: number
  /** In the pid list, but gone by the time its args are asked for (ps then exits 1). */
  vanishes?: boolean
}

const exit1 = (stdout: string): Error => Object.assign(new Error('Command failed: ps'), { code: 1, stdout })

/** A fake macOS: `table` is every process ps can see. Each opener (the sh that execs open) is in it
 *  with its own argv, the tag included, since open's own process carries it too. `onOpen` is told the
 *  tag of every bundle launch, to make the app's process appear. */
const rig = () => {
  const procs: Array<{ file: string; args: string[]; env: Record<string, string>; cwd?: string; stderr?: boolean; pid: number; exit(why: string): void }> = []
  const execs: Array<[string, string[]]> = []
  const starts = new Map<number, number>()
  const treesKilled: number[] = []
  const log: string[] = []
  const sleeps: Array<{ ms: number; signal?: AbortSignal }> = []
  const table: Row[] = []
  let clock = at(27, 10, 11, 12)
  let nextPid = 800
  const r = {
    onOpen: (_tag: string): void => {},
    now: () => clock
  }
  const visible = (): Row[] => table.filter((x) => x.from === undefined || clock >= x.from)
  const deps: MacDeskDeps = {
    spawn: (file, args, o) => {
      const pid = nextPid++
      const cbs: Array<(why: string) => void> = []
      let ended: string | null = null
      const exit = (why: string): void => {
        if (ended !== null) return
        ended = why
        for (const cb of cbs) cb(why)
      }
      procs.push({ file, args, env: o.env, cwd: o.cwd, stderr: o.stderr, pid, exit })
      starts.set(pid, clock)
      if (args[1]?.startsWith('exec open ')) {
        table.push({ pid, startedAt: clock, args: `open -g -j -n -a ${args[2]} --args ${args[3]}` })
        r.onOpen(args[3])
      }
      return {
        pid,
        onExit: (cb) => {
          if (ended !== null) cb(ended)
          else cbs.push(cb)
        },
        stderrTail: () => (ended !== null && ended !== 'exited 0' ? 'LSOpenURLsWithRole() failed with error -10810' : ''),
        kill: () => {}
      }
    },
    exec: async (file, args) => {
      execs.push([file, args])
      const ps = args.slice(2)
      if (JSON.stringify(ps) === JSON.stringify(BUNDLE_LIST_PS)) return visible().map((x) => `${String(x.pid).padStart(5)} ${lstart(x.startedAt)}\n`).join('')
      if (JSON.stringify(ps.slice(0, -1)) === JSON.stringify(BUNDLE_ARGS_PS)) {
        const want = ps[ps.length - 1].split(',').map(Number)
        const rows = visible().filter((x) => want.includes(x.pid) && !x.vanishes)
        const text = rows.map((x) => `${String(x.pid).padStart(5)} ${x.args}\n`).join('')
        if (rows.length < want.length) throw exit1(text)
        return text
      }
      throw new Error(`unexpected exec ${file} ${args.join(' ')}`)
    },
    startTime: async (pid) => starts.get(pid) ?? null,
    killTree: async (pid) => {
      treesKilled.push(pid)
      starts.delete(pid)
    },
    sleep: async (ms, signal) => {
      sleeps.push({ ms, signal })
      clock += ms
    },
    now: () => clock,
    log: (m) => log.push(m)
  }
  return Object.assign(r, { deps, desks: createMacDesks(deps), procs, execs, starts, treesKilled, log, sleeps, table })
}

/** Every bundle launch's app process appears `after` ms later, tagged, at the next free app pid. */
const appsAppear = (r: ReturnType<typeof rig>, bundle: string, after = 0): number[] => {
  const pids: number[] = []
  let next = 901
  r.onOpen = (tag) => {
    const pid = next++
    pids.push(pid)
    const from = r.now() + after
    r.table.push({ pid, startedAt: from, from, args: `${bundle}/Contents/MacOS/App --remote-debugging-port=9333 ${tag} ${MAC_BACKGROUND_FLAGS}` })
  }
  return pids
}

describe('the macOS desk', () => {
  it('creates nothing: its name is mac-bg-<name> and it has no helper process (R7, R11)', async () => {
    const desk: DeskHandle = await rig().desks.start('astera-ws-1-1')
    expect(desk.name).toBe('mac-bg-astera-ws-1-1')
    expect(desk.pid).toBeNull()
    expect(desk.alive()).toBe(true)
  })

  it('launches a command through sh in its own group, with the background flags and the rest of its env untouched', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const got = await desk.launch({ command: 'npm run dev', cwd: '/Users/me/proj', env: { ELECTRON_ENABLE_LOGGING: '1', ASTERA_APP_CDP_PORT: '9333' } })
    expect(r.procs[0]).toMatchObject({
      file: 'sh',
      // `wait` keeps sh, the group's leader, alive while anything the command backgrounded still runs.
      // A blank line before it, so a command ending in a backslash cannot join `wait` (review M3).
      args: ['-c', 'npm run dev\n\nwait'],
      cwd: '/Users/me/proj',
      env: { ELECTRON_ENABLE_LOGGING: '1', ASTERA_APP_CDP_PORT: '9333', ASTERA_APP_CHROMIUM_FLAGS: MAC_BACKGROUND_FLAGS }
    })
    expect(MAC_BACKGROUND_FLAGS).toBe('--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling')
    expect(got).toEqual({ pid: r.procs[0].pid, startedAt: at(27, 10, 11, 12) })
  })

  it('opens an app bundle with open -g -j -n and a tag of its own, and adopts only the process that carries it (R6, fix round 1)', async () => {
    const r = rig()
    const bundle = '/Applications/My App.app'
    r.table.push(
      { pid: 1, startedAt: at(27, 9, 0, 0), args: '/sbin/launchd' },
      { pid: 900, startedAt: at(27, 9, 0, 0), args: `${bundle}/Contents/MacOS/My App` },
      // The person's own instance, started inside the launch window: never ours.
      { pid: 903, startedAt: at(27, 10, 11, 12), args: `${bundle}/Contents/MacOS/My App --remote-debugging-port=9222` }
    )
    r.onOpen = (tag) => {
      r.table.push(
        { pid: 901, startedAt: at(27, 10, 11, 13), args: `${bundle}/Contents/MacOS/My App --remote-debugging-port=9333 ${tag} ${MAC_BACKGROUND_FLAGS}` },
        { pid: 902, startedAt: at(27, 10, 11, 13), args: `${bundle}/Contents/Frameworks/My App Helper.app/Contents/MacOS/My App Helper --type=renderer` }
      )
    }
    const desk = await r.desks.start('a')
    const got = await desk.launch({ command: '"/Applications/My App.app" --remote-debugging-port=$ASTERA_APP_CDP_PORT', cwd: '/Users/me/proj', env: {} })
    expect(r.procs[0].args).toEqual([
      '-c',
      'exec open -g -j -n -a "$0" --args "$1" --remote-debugging-port=$ASTERA_APP_CDP_PORT $ASTERA_APP_CHROMIUM_FLAGS',
      bundle,
      '--astera-desk=mac-bg-a-1'
    ])
    // -ww: without a tty ps cuts the command column short, and a long bundle path would never match.
    expect(r.execs[0]).toEqual(['env', ['LC_ALL=C', 'ps', '-ww', '-Ao', 'pid=,lstart=']])
    expect(r.execs[1][1].slice(0, 5)).toEqual(['LC_ALL=C', 'ps', '-ww', '-o', 'pid=,args='])
    expect(got).toEqual({ pid: 901, startedAt: at(27, 10, 11, 13) })
  })

  it('never adopts the person own instance started in the window, even when ours never comes', async () => {
    const r = rig()
    r.table.push({ pid: 903, startedAt: at(27, 10, 11, 13), args: '/A.app/Contents/MacOS/A' })
    const desk = await r.desks.start('a')
    await expect(desk.launch({ command: '/A.app', cwd: '/', env: {} })).rejects.toThrow('no process of it appeared')
    expect(r.treesKilled).toEqual([])
  })

  it('gives two launches of the same bundle at the same moment each its own pid', async () => {
    const r = rig()
    const pids = appsAppear(r, '/A.app', 400)
    const desk = await r.desks.start('a')
    const [one, two] = await Promise.all([desk.launch({ command: '/A.app', cwd: '/', env: {} }), desk.launch({ command: '/A.app', cwd: '/', env: {} })])
    expect([one.pid, two.pid]).toEqual(pids)
    expect(r.procs.map((p) => p.args[3])).toEqual(['--astera-desk=mac-bg-a-1', '--astera-desk=mac-bg-a-2'])
  })

  it('gives two desks launching the same bundle at the same moment each its own pid', async () => {
    const r = rig()
    const pids = appsAppear(r, '/A.app', 400)
    const [a, b] = await Promise.all([r.desks.start('a'), r.desks.start('b')])
    const [one, two] = await Promise.all([a.launch({ command: '/A.app', cwd: '/', env: {} }), b.launch({ command: '/A.app', cwd: '/', env: {} })])
    expect([one.pid, two.pid]).toEqual(pids)
  })

  it('a second launch from the same desk returns the new pid, not the first one still running', async () => {
    const r = rig()
    appsAppear(r, '/A.app')
    const desk = await r.desks.start('a')
    const one = await desk.launch({ command: '/A.app', cwd: '/', env: {} })
    const two = await desk.launch({ command: '/A.app', cwd: '/', env: {} })
    expect([one.pid, two.pid]).toEqual([901, 902])
  })

  it('fails the launch when no process of the bundle appears within the ready limit', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    await expect(desk.launch({ command: '/Applications/Gone.app', cwd: '/', env: {} })).rejects.toThrow(
      'launch: /Applications/Gone.app was opened, but no process of it appeared within 5 s'
    )
  })

  it('ends an app that appears after the ready limit, and still fails the launch', async () => {
    const r = rig()
    const apps = appsAppear(r, '/A.app', DESK_READY_MS + 1_000)
    const desk = await r.desks.start('a')
    await expect(desk.launch({ command: '/A.app', cwd: '/', env: {} })).rejects.toThrow('no process of it appeared within 5 s')
    expect(r.treesKilled).toEqual([apps[0]])
    await desk.close()
    expect(r.treesKilled).toEqual([apps[0]])
  })

  it('refuses windows, windowShot and keys with the reason', async () => {
    const desk = await rig().desks.start('a')
    await expect(desk.windows()).rejects.toThrow('windows: not available on macOS (the app runs in the background and only its page can be driven)')
    await expect(desk.shot({ format: 'png' })).rejects.toThrow(macRefusal('windowShot'))
    await expect(desk.keys({ title: 'x', text: 'y' })).rejects.toThrow(macRefusal('keys'))
  })

  it('kills a launched group only while its start time matches, and close ends every one still its own', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const one = await desk.launch({ command: 'a', cwd: '/', env: {} })
    const two = await desk.launch({ command: 'b', cwd: '/', env: {} })
    const three = await desk.launch({ command: 'c', cwd: '/', env: {} })
    // A mismatch means the pid is someone else's now: it is forgotten, and close leaves it alone too.
    await desk.kill(one.pid, one.startedAt + 60_000)
    expect(r.treesKilled).toEqual([])
    expect(r.log.some((l) => l.includes(`start time mismatch: pid ${one.pid}`))).toBe(true)
    await desk.close()
    expect(r.treesKilled).toEqual([two.pid, three.pid])
    expect(desk.alive()).toBe(false)
    await expect(desk.launch({ command: 'c', cwd: '/', env: {} })).rejects.toThrow('this workspace is closed')
  })
})

describe('the macOS desk: start times, failures and close', () => {
  it('never takes a start time from the clock: an app already gone is recorded with 0 and never killed for', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    r.deps.startTime = async () => null
    const got = await desk.launch({ command: 'true', cwd: '/', env: {} })
    expect(got).toEqual({ pid: r.procs[0].pid, startedAt: 0 })
    expect(r.log.some((l) => l.includes(`pid ${got.pid} exited before its start time could be read`))).toBe(true)
    await desk.close()
    expect(r.treesKilled).toEqual([])
  })

  it('ends the fresh group and rethrows when the launched start time cannot be read', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    r.deps.startTime = async () => {
      throw Object.assign(new Error('spawn env ENOENT'), { code: 'ENOENT' })
    }
    await expect(desk.launch({ command: 'app', cwd: '/', env: {} })).rejects.toThrow('spawn env ENOENT')
    expect(r.treesKilled).toEqual([r.procs[0].pid])
  })

  it('still rethrows the start time failure when ending that group fails too, and logs the second failure', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    r.deps.startTime = async () => {
      throw new Error('ps timed out')
    }
    r.deps.killTree = async () => {
      throw new Error('EPERM')
    }
    await expect(desk.launch({ command: 'app', cwd: '/', env: {} })).rejects.toThrow('ps timed out')
    expect(r.log.some((l) => l.includes(`pid ${r.procs[0].pid} could not be ended: EPERM`))).toBe(true)
  })

  it('refuses a launch whose sh never got a pid, with the reason', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    r.deps.spawn = () => ({ pid: undefined, onExit: () => {}, stderrTail: () => 'spawn sh ENOENT', kill: () => {} })
    await expect(desk.launch({ command: 'app', cwd: '/', env: {} })).rejects.toThrow('launch: sh could not start (spawn sh ENOENT)')
    await expect(desk.launch({ command: '/Applications/A.app', cwd: '/', env: {} })).rejects.toThrow('launch: sh could not start (spawn sh ENOENT)')
  })

  it('fails a bundle launch at once, with the reason, when open itself fails', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    r.deps.sleep = async (ms) => {
      r.procs[0].exit('exited 1')
      void ms
    }
    await expect(desk.launch({ command: '/Applications/Broken.app', cwd: '/', env: {} })).rejects.toThrow(
      'launch: open could not start /Applications/Broken.app (exited 1: LSOpenURLsWithRole() failed with error -10810)'
    )
    expect(r.procs[0].stderr).toBe(true)
  })

  it('fails at once when open fails: no further ps, no late sweep, no wait for the ready limit (stage 4 T6)', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    let clock = r.now()
    r.deps.now = () => clock
    r.deps.sleep = async (ms) => {
      r.sleeps.push({ ms })
      clock += ms
      r.procs[0].exit('exited 1')
    }
    await expect(desk.launch({ command: '/Applications/Broken.app', cwd: '/', env: {} })).rejects.toThrow('launch: open could not start')
    // One poll before open's exit was seen, and nothing after it.
    expect(r.execs).toHaveLength(1)
    expect(r.sleeps).toHaveLength(1)
  })

  it("reports open's own failure, not a missing process, when it fails in the same poll the limit passes (review M1)", async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    r.deps.sleep = async (ms) => {
      r.procs[0].exit('exited 1')
      // The clock jumps past the ready limit in the same poll.
      r.deps.now = () => at(27, 10, 11, 12) + DESK_READY_MS + ms
    }
    await expect(desk.launch({ command: '/Applications/Broken.app', cwd: '/', env: {} })).rejects.toThrow(
      'launch: open could not start /Applications/Broken.app (exited 1: LSOpenURLsWithRole() failed with error -10810)'
    )
  })

  it('puts the tag first after --args, so a comment, a `;` or a `--` in the rest cannot cut it off (review I2)', async () => {
    const r = rig()
    appsAppear(r, '/A.app')
    const desk = await r.desks.start('a')
    await desk.launch({ command: '/A.app --x -- y ; z # note', cwd: '/', env: {} })
    expect(r.procs[0].args[1]).toBe('exec open -g -j -n -a "$0" --args "$1" --x -- y ; z # note $ASTERA_APP_CHROMIUM_FLAGS')
    expect(r.procs[0].args[3]).toBe('--astera-desk=mac-bg-a-1')
  })

  it.runIf(process.platform !== 'win32')('hands open the tag through a real sh, whatever the rest holds (review I2)', async () => {
    const r = rig()
    appsAppear(r, '/A.app')
    const desk = await r.desks.start('a')
    await desk.launch({ command: '/A.app --x # note', cwd: '/', env: {} })
    const [, script, bundle, tag] = r.procs[0].args
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-deskmac-open-'))
    try {
      // A stand in for open that prints each argument it got on a line of its own.
      await fs.writeFile(path.join(dir, 'open'), '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n', { mode: 0o755 })
      const out = await new Promise<string>((resolve, reject) =>
        execFile('sh', ['-c', script, bundle, tag], { env: { PATH: `${dir}:/usr/bin:/bin`, ASTERA_APP_CHROMIUM_FLAGS: '--f1' } }, (err, stdout) =>
          err ? reject(err) : resolve(stdout)
        )
      )
      expect(out.split('\n').filter(Boolean)).toEqual(['-g', '-j', '-n', '-a', '/A.app', '--args', tag, '--x'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps looking after open exits 0, since the app may appear a moment later', async () => {
    const r = rig()
    appsAppear(r, '/A.app', 400)
    const desk = await r.desks.start('a')
    const real = r.deps.sleep
    r.deps.sleep = async (ms, signal) => {
      r.procs[0].exit('exited 0')
      await real(ms, signal)
    }
    await expect(desk.launch({ command: '/A.app', cwd: '/', env: {} })).resolves.toMatchObject({ pid: 901 })
  })

  it('does not adopt a candidate that vanished between the two ps calls (ps exits 1 then)', async () => {
    const r = rig()
    r.table.push({ pid: 950, startedAt: at(27, 10, 11, 12), args: 'x', vanishes: true })
    appsAppear(r, '/A.app')
    const desk = await r.desks.start('a')
    await expect(desk.launch({ command: '/A.app', cwd: '/', env: {} })).resolves.toMatchObject({ pid: 901 })
  })

  it('retries ps once when it fails, and finds the app', async () => {
    const r = rig()
    appsAppear(r, '/A.app')
    const desk = await r.desks.start('a')
    const real = r.deps.exec
    let failed = false
    r.deps.exec = async (file, args) => {
      if (!failed) {
        failed = true
        throw Object.assign(new Error('ps timed out'), { killed: true })
      }
      return real(file, args)
    }
    await expect(desk.launch({ command: '/A.app', cwd: '/', env: {} })).resolves.toMatchObject({ pid: 901 })
  })

  it('fails a bundle launch with the ps failure when the retry fails too', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    let calls = 0
    r.deps.exec = async () => {
      calls++
      throw Object.assign(new Error('spawn env ENOENT'), { code: 'ENOENT' })
    }
    await expect(desk.launch({ command: '/A.app', cwd: '/', env: {} })).rejects.toThrow(
      'launch: /A.app was opened, but ps could not list its processes: spawn env ENOENT'
    )
    expect(calls).toBe(2)
  })

  it('resolves a relative bundle against the launch folder, with POSIX paths', async () => {
    const r = rig()
    const apps = appsAppear(r, '/Users/me/proj/dist/mac/Foo.app')
    const desk = await r.desks.start('a')
    const got = await desk.launch({ command: "'./dist/mac/Foo.app/'", cwd: '/Users/me/proj', env: {} })
    expect(r.procs[0].args[2]).toBe('/Users/me/proj/dist/mac/Foo.app')
    expect(got.pid).toBe(apps[0])
  })

  it('a bundle launch that close interrupts stops waiting at once, ends the app that turns up late, and rejects', async () => {
    const r = rig()
    const apps = appsAppear(r, '/A.app', 600)
    const desk = await r.desks.start('a')
    const real = r.deps.sleep
    // A sleep on a signal waits for it to abort; a sleep with none moves the clock.
    r.deps.sleep = (ms, signal) =>
      signal
        ? new Promise<void>((resolve) => {
            r.sleeps.push({ ms, signal })
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
        : real(ms)
    const going = desk.launch({ command: '/A.app', cwd: '/', env: {} })
    const settled = expect(going).rejects.toThrow('launch: this workspace is closed')
    await new Promise((res) => setImmediate(res))
    expect(r.sleeps.length).toBe(1)
    await desk.close()
    expect(r.sleeps[0].signal?.aborted).toBe(true)
    await settled
    // The late look never sleeps on the aborted signal.
    expect(r.sleeps.slice(1).every((s) => s.signal === undefined)).toBe(true)
    expect(r.treesKilled).toEqual([apps[0]])
  })

  it('a bundle process found after close is ended at once, not left running', async () => {
    const r = rig()
    appsAppear(r, '/A.app')
    const desk = await r.desks.start('a')
    const real = r.deps.exec
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    r.deps.exec = async (file, args) => {
      await gate
      return real(file, args)
    }
    const going = desk.launch({ command: '/A.app', cwd: '/', env: {} })
    const settled = expect(going).rejects.toThrow('launch: this workspace is closed')
    await new Promise((res) => setImmediate(res))
    await desk.close()
    release()
    await settled
    expect(r.treesKilled).toEqual([901])
  })

  it('a command whose start time arrives after close is ended at once, not left running', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    let release!: (ms: number) => void
    r.deps.startTime = () => new Promise<number>((res) => (release = res))
    const going = desk.launch({ command: 'app', cwd: '/', env: {} })
    const settled = expect(going).rejects.toThrow('launch: this workspace is closed')
    await new Promise((res) => setImmediate(res))
    await desk.close()
    release(at(27, 10, 11, 12))
    await settled
    expect(r.treesKilled).toEqual([r.procs[0].pid])
  })

  it('a command found gone after close rejects as closed, not with start time 0', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    let release!: (ms: number | null) => void
    r.deps.startTime = () => new Promise<number | null>((res) => (release = res))
    const going = desk.launch({ command: 'app', cwd: '/', env: {} })
    const settled = expect(going).rejects.toThrow('launch: this workspace is closed')
    await new Promise((res) => setImmediate(res))
    await desk.close()
    release(null)
    await settled
  })

  it('close resolves and goes on to the next group when ending one fails, and logs it', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const one = await desk.launch({ command: 'a', cwd: '/', env: {} })
    const two = await desk.launch({ command: 'b', cwd: '/', env: {} })
    const real = r.deps.killTree
    r.deps.killTree = async (pid) => (pid === one.pid ? Promise.reject(new Error('EPERM')) : real(pid))
    await expect(desk.close()).resolves.toBeUndefined()
    expect(r.treesKilled).toEqual([two.pid])
    expect(r.log.some((l) => l.includes(`pid ${one.pid} could not be ended: EPERM`))).toBe(true)
  })

  it('close resolves when reading a start time fails, and logs it', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const one = await desk.launch({ command: 'a', cwd: '/', env: {} })
    r.deps.startTime = async () => {
      throw new Error('ps timed out')
    }
    await expect(desk.close()).resolves.toBeUndefined()
    expect(r.log.some((l) => l.includes(`pid ${one.pid} could not be ended: ps timed out`))).toBe(true)
  })
})

describe('the macOS desk: pure parts', () => {
  it('reads an app bundle as the first word, quoted or not', () => {
    expect(bundleCommand('/Applications/Foo.app')).toEqual({ bundle: '/Applications/Foo.app', rest: '' })
    expect(bundleCommand('"/Applications/My App.app" --x')).toEqual({ bundle: '/Applications/My App.app', rest: '--x' })
    expect(bundleCommand("'./dist/mac/Foo.app/' --remote-debugging-port=$ASTERA_APP_CDP_PORT")).toEqual({
      bundle: './dist/mac/Foo.app',
      rest: '--remote-debugging-port=$ASTERA_APP_CDP_PORT'
    })
    expect(bundleCommand('open Foo.app')).toBeNull()
    expect(bundleCommand('npm run dev')).toBeNull()
    expect(bundleCommand('./foo.apple')).toBeNull()
  })

  it('lists the processes that started at or after the launch, within the start time tolerance', () => {
    const ps = `    5 ${lstart(at(27, 10, 0, 0))}\n    6 ${lstart(at(27, 10, 0, 9))}\n  garbage\n`
    expect(recentStarts(ps, at(27, 10, 0, 10))).toEqual(new Map([[6, at(27, 10, 0, 9)]]))
    expect(recentStarts(ps, at(27, 10, 0, 30)).size).toBe(0)
  })

  it('knows a tag only as a whole argument', () => {
    expect(hasTag('/A.app/Contents/MacOS/A --astera-desk=mac-bg-a-1 --x', '--astera-desk=mac-bg-a-1')).toBe(true)
    expect(hasTag('/A.app/Contents/MacOS/A --astera-desk=mac-bg-a-1', '--astera-desk=mac-bg-a-1')).toBe(true)
    expect(hasTag('/A.app/Contents/MacOS/A --astera-desk=mac-bg-a-10', '--astera-desk=mac-bg-a-1')).toBe(false)
    expect(hasTag('/A.app/Contents/MacOS/A x--astera-desk=mac-bg-a-1', '--astera-desk=mac-bg-a-1')).toBe(false)
  })

  it('picks the earliest tagged candidate, never an excluded pid or one outside the candidates', () => {
    const starts = new Map([
      [10, 5_000],
      [11, 4_000],
      [12, 4_000],
      [13, 1_000]
    ])
    const args = ['   10 /A.app/Contents/MacOS/A --t', '   11 /A.app/Contents/MacOS/A --t', '   12 /A.app/Contents/MacOS/A --t', '   13 /A.app/x', '   14 /A --t'].join('\n')
    expect(pickTagged(args, '--t', starts, new Set())).toEqual({ pid: 11, startedAt: 4_000 })
    expect(pickTagged(args, '--t', starts, new Set([11, 12]))).toEqual({ pid: 10, startedAt: 5_000 })
    expect(pickTagged(args, '--u', starts, new Set())).toBeNull()
  })
})

describe('the macOS desk: real deps', () => {
  it('ends a real sleep, and clears its timer, when its signal aborts', async () => {
    const d = realMacDeskDeps({ log: () => {} })
    const stop = new AbortController()
    const t0 = Date.now()
    const done = d.sleep(60_000, stop.signal)
    stop.abort()
    await done
    await d.sleep(60_000, stop.signal)
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  it('takes its abort listener off the signal again when the timer ends the sleep (fix round 1)', async () => {
    const d = realMacDeskDeps({ log: () => {} })
    const stop = new AbortController()
    const add = vi.spyOn(stop.signal, 'addEventListener')
    const remove = vi.spyOn(stop.signal, 'removeEventListener')
    for (let i = 0; i < 3; i++) await d.sleep(1, stop.signal)
    expect(add).toHaveBeenCalledTimes(3)
    expect(remove).toHaveBeenCalledTimes(3)
    for (let i = 0; i < 3; i++) expect(remove.mock.calls[i].slice(0, 2)).toEqual(add.mock.calls[i].slice(0, 2))
  })

  const gone = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }
  const settle = async (ok: () => boolean): Promise<void> => {
    for (let i = 0; i < 50 && !ok(); i++) await new Promise((res) => setTimeout(res, 100))
  }

  it.runIf(process.platform === 'darwin')(
    'launches a real command with its start time from ps, and kill ends what it put in the background too',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-deskmac-'))
      const pidFile = path.posix.join(dir, 'bg.pid')
      const desk = await createMacDesks(realMacDeskDeps({ log: () => {} })).start('real')
      try {
        const t0 = Date.now()
        const got = await desk.launch({ command: `sleep 30 &\necho $! > "${pidFile}"`, cwd: dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })
        // lstart has whole seconds, so the start time is at most a second before the clock read.
        expect(got.startedAt).toBeGreaterThan(t0 - 2_000)
        expect(got.startedAt).toBeLessThanOrEqual(Date.now())
        let bg = 0
        for (let i = 0; i < 50 && !bg; i++) {
          bg = Number((await fs.readFile(pidFile, 'utf8').catch(() => '')).trim()) || 0
          if (!bg) await new Promise((res) => setTimeout(res, 100))
        }
        expect(bg).toBeGreaterThan(1)
        await desk.kill(got.pid, got.startedAt)
        await settle(() => gone(got.pid) && gone(bg))
        expect(gone(got.pid)).toBe(true)
        expect(gone(bg)).toBe(true)
      } finally {
        await desk.close()
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
    20_000
  )

  it.runIf(process.platform === 'darwin')(
    'kill ends a child the launched command started detached, in a session of its own, while its parent still runs',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-deskmac-tree-'))
      const pidFile = path.posix.join(dir, 'child.pid')
      const script = path.posix.join(dir, 'parent.cjs')
      // The parent stays, as a dev Astera's Electron does beside the Host it started detached.
      await fs.writeFile(
        script,
        "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })\n" +
          "require('node:fs').writeFileSync(process.argv[2], String(c.pid))\nc.unref()\nsetInterval(() => {}, 1000)\n"
      )
      const desk = await createMacDesks(realMacDeskDeps({ log: () => {} })).start('real-tree')
      let child = 0
      try {
        const got = await desk.launch({ command: `"${process.execPath}" "${script}" "${pidFile}"`, cwd: dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })
        for (let i = 0; i < 50 && !child; i++) {
          child = Number((await fs.readFile(pidFile, 'utf8').catch(() => '')).trim()) || 0
          if (!child) await new Promise((res) => setTimeout(res, 100))
        }
        expect(child).toBeGreaterThan(1)
        await desk.kill(got.pid, got.startedAt)
        await settle(() => gone(got.pid) && gone(child))
        expect(gone(got.pid)).toBe(true)
        expect(gone(child)).toBe(true)
      } finally {
        await desk.close()
        if (child > 1 && !gone(child)) process.kill(child, 'SIGKILL')
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
    20_000
  )

  it.runIf(process.platform === 'darwin')(
    'opens a real app bundle in the background, finds its process by the tag, and kill ends it (fix round 1)',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-deskmac-app-'))
      const app = path.posix.join(dir, 'Astera Desk Probe With A Long Name To Pass Seventy Nine Columns.app')
      const macos = path.posix.join(app, 'Contents', 'MacOS')
      await fs.mkdir(macos, { recursive: true })
      const plist = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0"><dict>',
        '<key>CFBundleExecutable</key><string>probe</string>',
        `<key>CFBundleIdentifier</key><string>com.astera.test.deskprobe${process.pid}</string>`,
        '<key>CFBundleName</key><string>Probe</string>',
        '<key>CFBundlePackageType</key><string>APPL</string>',
        '<key>LSBackgroundOnly</key><true/>',
        '</dict></plist>',
        ''
      ].join('\n')
      await fs.writeFile(path.posix.join(app, 'Contents', 'Info.plist'), plist)
      // Not `exec sleep`: the script's own process must keep the argv open passed it, tag included.
      await fs.writeFile(path.posix.join(macos, 'probe'), '#!/bin/sh\nsleep 60 &\nwait\n', { mode: 0o755 })
      const desk = await createMacDesks(realMacDeskDeps({ log: () => {} })).start(`real-app-${process.pid}`)
      try {
        const got = await desk.launch({ command: `"${app}"`, cwd: dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })
        expect(got.pid).toBeGreaterThan(1)
        expect(gone(got.pid)).toBe(false)
        await desk.kill(got.pid, got.startedAt)
        await settle(() => gone(got.pid))
        expect(gone(got.pid)).toBe(true)
      } finally {
        await desk.close()
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
    30_000
  )
})
