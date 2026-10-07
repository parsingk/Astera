import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NAMED_KEYS } from '../../core/workspace/helpers'
import { DESK_CLOSE_MS, DESK_READY_MS, type DeskWindow } from '../../core/workspace/protocol'
import {
  DRAG_STEPS,
  KEYMAP_SETTLE_MS,
  PARKED_POINTER,
  PRESS_GAP_MS,
  REMAP_CHUNK,
  REMAP_DELAY_MS,
  TYPE_CHUNK,
  XDOTOOL_KEYS,
  createLinuxDesks,
  displayEnv,
  freeKeycodes,
  imageSize,
  keymapPieces,
  parseGeometry,
  pickWindow,
  pressArgs,
  realLinuxDeskDeps,
  specialChars,
  typeRuns,
  utf8Env,
  withKeysyms,
  type LinuxDeskDeps
} from './deskLinux'
import type { SpawnedProc } from './posixProc'

type Mode = 'ready' | 'exit' | 'hang'

interface FakeProc extends SpawnedProc {
  file: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  mode: Mode
  readyFd: boolean
  /** What it wrote to its -displayfd pipe so far. */
  reported: string
  signals: string[]
  exit(why: string): void
}

const png = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

/** SOI, an APP0 segment, and a SOF0 segment holding the size. */
const jpeg = (w: number, h: number): Buffer => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0)])
  const sof = Buffer.alloc(19)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(h, 5)
  sof.writeUInt16BE(w, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])
}

const exit1 = (): Error => Object.assign(new Error('Command failed'), { code: 1 })

/** Every Xvfb spawned takes the next mode of `plan` (ready when the plan runs out): 'ready' makes its
 *  socket and writes its display number to its -displayfd pipe on the first poll, 'exit' exits on the
 *  first poll leaving a lock file behind (another Host holds the number), 'hang' never does either. */
const rig = (plan: Mode[] = []) => {
  const files = new Set<string>()
  const procs: FakeProc[] = []
  const runs: Array<{ file: string; args: string[]; env: Record<string, string> }> = []
  const starts = new Map<number, number>()
  const groupsKilled: number[] = []
  const log: string[] = []
  const sleeps: Array<{ ms: number; signal?: AbortSignal }> = []
  const answers: Array<(file: string, args: string[]) => Buffer | Error | undefined> = []
  /** Private runtime folders made and not yet removed, and every one ever made. */
  const dirs = new Set<string>()
  const made: string[] = []
  const written: Array<{ path: string; text: string }> = []
  let clock = 1_000_000
  let nextPid = 700
  let xvfbs = 0
  const numberOf = (p: FakeProc): string => p.args[0].slice(1)
  const deps: LinuxDeskDeps = {
    hostEnv: {
      PATH: '/usr/bin',
      HOME: '/home/me',
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus'
    },
    spawn: (file, args, o) => {
      const cbs: Array<(why: string) => void> = []
      let ended: string | null = null
      const p: FakeProc = {
        file,
        args,
        env: o.env,
        cwd: o.cwd,
        signals: [],
        mode: file === 'Xvfb' ? (plan[xvfbs++] ?? 'ready') : 'ready',
        readyFd: o.readyFd === true,
        reported: '',
        readyText: () => p.reported,
        pid: nextPid++,
        onExit: (cb) => {
          if (ended !== null) cb(ended)
          else cbs.push(cb)
        },
        stderrTail: () => (p.mode === 'exit' ? '(EE) Server is already active for display' : ''),
        kill: (sig = 'SIGTERM') => {
          p.signals.push(sig)
          if (p.file === 'Xvfb') files.delete(`/tmp/.X11-unix/X${numberOf(p)}`)
          p.exit(`exited ${sig}`)
        },
        exit: (why) => {
          if (ended !== null) return
          ended = why
          starts.delete(p.pid!)
          for (const cb of cbs) cb(why)
        }
      }
      procs.push(p)
      starts.set(p.pid!, clock)
      return p
    },
    run: async (file, args, env) => {
      runs.push({ file, args, env })
      for (const a of answers) {
        const r = a(file, args)
        if (r instanceof Error) throw r
        if (r !== undefined) return r
      }
      return Buffer.alloc(0)
    },
    exists: async (p) => files.has(p),
    makeRuntimeDir: async () => {
      const dir = `/tmp/astera-xrt-${made.length + 1}`
      made.push(dir)
      dirs.add(dir)
      return dir
    },
    removeDir: async (p) => {
      dirs.delete(p)
    },
    writeFile: async (p, text) => {
      written.push({ path: p, text })
    },
    startTime: async (pid) => starts.get(pid) ?? null,
    killGroup: async (pid) => {
      groupsKilled.push(pid)
      starts.delete(pid)
    },
    sleep: async (ms, signal) => {
      sleeps.push({ ms, signal })
      clock += ms
      for (const p of procs) {
        if (p.file !== 'Xvfb' || p.signals.length > 0) continue
        if (p.mode === 'ready') {
          files.add(`/tmp/.X11-unix/X${numberOf(p)}`)
          if (p.readyFd) p.reported = `${numberOf(p)}\n`
        }
        if (p.mode === 'exit') {
          files.add(`/tmp/.X${numberOf(p)}-lock`)
          p.exit('exited 1')
        }
      }
    },
    now: () => clock,
    log: (m) => log.push(m)
  }
  const xdo = (fn: (args: string[]) => Buffer | Error | undefined): void => {
    answers.push((file, args) => (file === 'xdotool' ? fn(args) : undefined))
  }
  return { deps, desks: createLinuxDesks(deps), files, procs, runs, starts, groupsKilled, log, sleeps, answers, xdo, dirs, made, written }
}

/** Three windows: a Hangul titled one with a pid, one with no _NET_WM_PID, and one that closes
 *  between the search and its questions. */
const threeWindows = (r: ReturnType<typeof rig>): void =>
  r.xdo((args) => {
    if (args[0] === 'search') return Buffer.from('41\n42\n43\n')
    if (args[0] === 'getwindowname') return args[1] === '41' ? Buffer.from('Astera 픽스처 창\n') : args[1] === '42' ? Buffer.from('no pid\n') : exit1()
    if (args[0] === 'getwindowgeometry')
      return Buffer.from(args[2] === '41' ? 'WINDOW=41\nX=0\nY=0\nWIDTH=900\nHEIGHT=700\nSCREEN=0\n' : 'WINDOW=42\nX=5\nY=5\nWIDTH=200\nHEIGHT=100\nSCREEN=0\n')
    if (args[0] === 'getwindowpid') return args[1] === '41' ? Buffer.from('4242\n') : exit1()
    return undefined
  })

describe('the Linux desk: Xvfb', () => {
  it('starts Xvfb on the first free display from 90, waits for it to report that display, and records its pid and start time', async () => {
    const r = rig()
    r.files.add('/tmp/.X11-unix/X90')
    r.files.add('/tmp/.X91-lock')
    const desk = await r.desks.start('astera-ws-1-1')
    const x = r.procs[0]
    expect(x.file).toBe('Xvfb')
    expect(x.args).toEqual([':92', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-noreset', '-displayfd', '3'])
    expect(x.readyFd).toBe(true)
    expect(desk.name).toBe('astera-ws-1-1')
    expect(desk.pid).toBe(x.pid)
    expect(desk.startedAt).toBe(1_000_000)
    expect(desk.alive()).toBe(true)
  })

  it('is not ready on a socket another X server made for its number after the probe (fix round 1)', async () => {
    const r = rig(['hang'])
    const spawn = r.deps.spawn
    r.deps.spawn = (file, args, o) => {
      // The foreign server's socket appears between the probe and this Xvfb's start.
      if (file === 'Xvfb') r.files.add(`/tmp/.X11-unix/X${args[0].slice(1)}`)
      return spawn(file, args, o)
    }
    await expect(r.desks.start('a')).rejects.toThrow(`Xvfb :90 did not open its display within ${DESK_READY_MS / 1000} s`)
    expect(r.procs[0].signals).toEqual(['SIGKILL'])
  })

  it('gives two desks that start at the same moment two displays (Review Focus 1)', async () => {
    const r = rig()
    const [a, b] = await Promise.all([r.desks.start('a'), r.desks.start('b')])
    expect(r.procs.map((p) => p.args[0]).sort()).toEqual([':90', ':91'])
    expect(a.pid).not.toBe(b.pid)
  })

  it('tries the next display when Xvfb exits before its socket appears (another Host took the number)', async () => {
    const r = rig(['exit', 'ready'])
    const desk = await r.desks.start('a')
    expect(r.procs.map((p) => p.args[0])).toEqual([':90', ':91'])
    expect(desk.pid).toBe(r.procs[1].pid)
    expect(r.log.some((l) => l.includes('Xvfb :90 exited before it was ready') && l.includes('already active'))).toBe(true)
  })

  it('gives up after three displays that all exit, with the last reason', async () => {
    const r = rig(['exit', 'exit', 'exit'])
    await expect(r.desks.start('a')).rejects.toThrow('Xvfb could not start: exited 1: (EE) Server is already active for display')
    expect(r.procs).toHaveLength(3)
  })

  it('fails within the ready limit when the socket never appears, kills that Xvfb, and frees the number', async () => {
    const r = rig(['hang'])
    await expect(r.desks.start('a')).rejects.toThrow(`Xvfb :90 did not open its display within ${DESK_READY_MS / 1000} s`)
    expect(r.procs[0].signals).toEqual(['SIGKILL'])
    await r.desks.start('b')
    expect(r.procs[1].args[0]).toBe(':90')
  })

  it('reports an Xvfb that dies later through onExit, and refuses to launch on it', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const why: string[] = []
    desk.onExit((w) => why.push(w))
    r.procs[0].exit('exited SIGKILL')
    expect(why).toEqual(['exited SIGKILL'])
    expect(desk.alive()).toBe(false)
    await expect(desk.launch({ command: 'app', cwd: '/p', env: {} })).rejects.toThrow('the virtual display ended (exited SIGKILL)')
  })
})

describe('the Linux desk: the pointer', () => {
  it('moves the pointer to the last pixel of the screen once Xvfb is ready, before anything is launched', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    expect(PARKED_POINTER).toEqual({ x: 1919, y: 1079 })
    expect(r.runs).toHaveLength(1)
    expect(r.runs[0]).toMatchObject({ file: 'xdotool', args: ['mousemove', '1919', '1079'] })
    expect(r.runs[0].env).toMatchObject({ DISPLAY: ':90', XDG_SESSION_TYPE: 'x11' })
    expect(r.runs[0].env.WAYLAND_DISPLAY).toBeUndefined()
    await desk.launch({ command: 'app', cwd: '/p', env: {} })
    expect(r.runs).toHaveLength(1)
  })

  it('still starts, and logs, when the pointer cannot be moved', async () => {
    const r = rig()
    r.xdo((args) => (args[0] === 'mousemove' ? new Error("Can't open display") : undefined))
    const desk = await r.desks.start('a')
    expect(desk.alive()).toBe(true)
    expect(r.log.some((l) => l.includes("desktop a: the pointer could not be moved out of the way: Can't open display"))).toBe(true)
  })
})

/** A small `xkbcomp -xkb` dump: four keycodes, two with symbols. */
const DUMP = [
  'xkb_keymap {',
  'xkb_keycodes "evdev" {',
  '    minimum = 8;',
  '    <AE01> = 10;',
  '    <AC01> = 38;',
  '    <I120> = 120;',
  '    <FK13> = 191;',
  '    alias <LatA> = <AC01>;',
  '};',
  'xkb_types "complete" {',
  '};',
  'xkb_symbols "pc+us" {',
  '    key <AE01> { [ 1, exclam ] };',
  '    key <AC01> { [ a, A ] };',
  '};',
  'xkb_geometry "pc(pc105)" {',
  '};',
  '};',
  ''
].join('\n')

describe('the Linux desk: typing with the needed characters bound first', () => {
  it('finds the keycodes nothing is bound to, and binds characters to them as Unicode keysyms', () => {
    expect(freeKeycodes(DUMP)).toEqual(['I120', 'FK13'])
    expect(freeKeycodes('nonsense')).toEqual([])
    const bound = withKeysyms(DUMP, [
      { keycode: 'I120', ch: '한' },
      { keycode: 'FK13', ch: 'é' }
    ])
    expect(bound).toContain('    key <AC01> { [ a, A ] };\n    key <I120> { [ UD55C ] };\n    key <FK13> { [ U00E9 ] };\n};\nxkb_geometry')
    expect(withKeysyms('no symbols here', [{ keycode: 'I120', ch: 'x' }])).toBe('no symbols here')
    expect(specialChars('hi 한글 한\n')).toEqual(['한', '글'])
  })

  it('cuts text into pieces with no more new characters than there are free keys', () => {
    expect(keymapPieces('ab한글c국어', 2)).toEqual(['ab한글c', '국어'])
    expect(keymapPieces('한한한한', 1)).toEqual(['한한한한'])
    expect(keymapPieces('a'.repeat(TYPE_CHUNK + 1), 5).map((p) => p.length)).toEqual([TYPE_CHUNK, 1])
    expect(keymapPieces('', 3)).toEqual([])
  })

  it('binds, waits, types at the default delay, waits, and puts the map back', async () => {
    const r = rig()
    threeWindows(r)
    r.answers.unshift((file, args) => (file === 'xkbcomp' && args.includes('-xkb') ? Buffer.from(DUMP) : undefined))
    const desk = await r.desks.start('a')
    await desk.keys({ title: 'astera', text: 'hi 한글' })
    const steps = r.runs.filter((x) => x.file === 'xkbcomp' || x.args[2] === 'type').map((x) => [x.file, ...x.args])
    const file = '/tmp/astera-xrt-1/keymap.xkb'
    expect(steps).toEqual([
      ['xkbcomp', '-w', '0', '-xkb', ':90', '-'],
      ['xkbcomp', '-w', '0', file, ':90'],
      ['xdotool', 'windowfocus', '41', 'type', '--', 'hi 한글'],
      ['xkbcomp', '-w', '0', file, ':90']
    ])
    expect(r.written.map((w) => w.path)).toEqual([file, file])
    expect(r.written[0].text).toContain('key <I120> { [ UD55C ] };\n    key <FK13> { [ UAE00 ] };')
    expect(r.written[1].text).toBe(DUMP)
    expect(r.sleeps.filter((x) => x.ms === KEYMAP_SETTLE_MS)).toHaveLength(2)
  })

  it('puts the map back when typing fails, and types the slow way when the map cannot be read', async () => {
    const r = rig()
    threeWindows(r)
    r.answers.unshift((file, args) => (file === 'xkbcomp' && args.includes('-xkb') ? Buffer.from(DUMP) : undefined))
    r.answers.unshift((file, args) => (file === 'xdotool' && args[2] === 'type' ? new Error('BadWindow') : undefined))
    const desk = await r.desks.start('a')
    await expect(desk.keys({ title: 'astera', text: '한' })).rejects.toThrow('BadWindow')
    expect(r.written.at(-1)!.text).toBe(DUMP)

    const s = rig()
    threeWindows(s)
    s.answers.unshift((file) => (file === 'xkbcomp' ? new Error('xkbcomp: not found') : undefined))
    const slow = await s.desks.start('a')
    await slow.keys({ title: 'astera', text: '한' })
    expect(s.runs.filter((x) => x.args[2] === 'type').map((x) => x.args)).toEqual([['windowfocus', '41', 'type', '--delay', '100', '--', '한']])
    expect(s.log.some((l) => l.includes('the keyboard map could not be read (xkbcomp: not found); typing slowly instead'))).toBe(true)
  })
})

describe("the Linux desk: drag()'s real pointer", () => {
  it('presses at the window origin plus the page point, moves in steps to the target, and lets go back in the corner', async () => {
    const r = rig()
    threeWindows(r)
    r.xdo((args) => (args[0] === 'getwindowgeometry' ? Buffer.from('WINDOW=41\nX=510\nY=190\nWIDTH=900\nHEIGHT=700\nSCREEN=0\n') : undefined))
    r.answers.reverse()
    const desk = await r.desks.start('a')
    await desk.pointer!.press({ title: '픽스처', from: { x: 48, y: 98 }, to: { x: 108, y: 158 } })
    const press = r.runs.at(-1)!
    expect(press.file).toBe('xdotool')
    expect(press.args).toEqual(pressArgs({ x: 558, y: 288 }, { x: 618, y: 348 }))
    expect(press.args.slice(0, 7)).toEqual(['mousemove', '558', '288', 'sleep', '0.05', 'mousedown', '1'])
    expect(press.args.slice(-5)).toEqual(['mousemove', '618', '348', 'sleep', '0.05'])
    expect(press.args.filter((a) => a === 'mousemove')).toHaveLength(1 + DRAG_STEPS)
    expect(r.log.some((l) => l.includes("dragging with the display's pointer from 558,288 to 618,348 (window 41 at 510,190)"))).toBe(true)
    await desk.pointer!.release()
    expect(r.runs.at(-1)!.args).toEqual(['mouseup', '1', 'mousemove', '1919', '1079'])
  })

  it('waits out a double click before pressing again, and names a window that is not there', async () => {
    const r = rig()
    threeWindows(r)
    const desk = await r.desks.start('a')
    await desk.pointer!.press({ title: '', from: { x: 1, y: 1 }, to: { x: 50, y: 50 } })
    const before = r.sleeps.length
    await desk.pointer!.press({ title: '', from: { x: 1, y: 1 }, to: { x: 50, y: 50 } })
    expect(r.sleeps.slice(before).map((s) => s.ms)).toEqual([PRESS_GAP_MS])
    await expect(desk.pointer!.press({ title: 'nothing like it', from: { x: 1, y: 1 }, to: { x: 2, y: 2 } })).rejects.toThrow('no window titled "nothing like it"')
    // CI run 36312079513: a page point above the window is refused, and nothing is pressed.
    const presses = r.runs.filter((x) => x.args.includes('mousedown')).length
    await expect(desk.pointer!.press({ title: '', from: { x: -60, y: -89 }, to: { x: 50, y: 50 } })).rejects.toThrow(
      'the point -60,-89 is outside the 900x700 window "Astera 픽스처 창", so the display\'s pointer was not pressed'
    )
    await expect(desk.pointer!.press({ title: '', from: { x: 1, y: 1 }, to: { x: 900, y: 5 } })).rejects.toThrow('the point 900,5 is outside')
    expect(r.runs.filter((x) => x.args.includes('mousedown'))).toHaveLength(presses)
  })

  it('gives xdotool a UTF-8 locale when the Host has none, and keeps one it has', async () => {
    expect(utf8Env({ PATH: '/bin' })).toEqual({ PATH: '/bin', LC_ALL: 'C.UTF-8' })
    expect(utf8Env({ LANG: 'C', LC_ALL: 'POSIX' })).toMatchObject({ LC_ALL: 'C.UTF-8' })
    expect(utf8Env({ LANG: 'ko_KR.UTF-8' })).toEqual({ LANG: 'ko_KR.UTF-8' })
    expect(utf8Env({ LC_CTYPE: 'en_US.utf8' })).toEqual({ LC_CTYPE: 'en_US.utf8' })
    const r = rig()
    threeWindows(r)
    const desk = await r.desks.start('a')
    await desk.keys({ title: 'astera', text: '한글' })
    const typed = r.runs.find((x) => x.args[2] === 'type')!
    expect(typed.env.LC_ALL).toBe('C.UTF-8')
    // The app itself is not given it: only the tool that decodes the text.
    await desk.launch({ command: 'app', cwd: '/p', env: {} })
    expect(r.procs.at(-1)!.env.LC_ALL).toBeUndefined()
  })
})

describe('the Linux desk: start times come from the kernel, never the clock', () => {
  it('ends that Xvfb, frees the number, and fails when its start time cannot be read', async () => {
    const r = rig()
    const real = r.deps.startTime
    r.deps.startTime = async () => null
    await expect(r.desks.start('a')).rejects.toThrow('Xvfb :90 ended before its start time could be read')
    expect(r.procs[0].signals).toEqual(['SIGKILL'])
    r.deps.startTime = real
    await r.desks.start('b')
    expect(r.procs[1].args[0]).toBe(':90')
  })

  it('records an app that is already gone with start time 0, which no live process matches, and never kills for it', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const real = r.deps.startTime
    r.deps.startTime = async (pid) => (pid === r.procs[0].pid ? real(pid) : null)
    const got = await desk.launch({ command: 'true', cwd: '/p', env: {} })
    expect(got).toEqual({ pid: r.procs[1].pid, startedAt: 0 })
    expect(r.log.some((l) => l.includes(`pid ${got.pid} exited before its start time could be read`))).toBe(true)
    await desk.close()
    expect(r.groupsKilled).toEqual([])
  })

  it('refuses a launch whose sh never got a pid, with the reason', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const spawn = r.deps.spawn
    r.deps.spawn = (file, args, o) => {
      const p = spawn(file, args, o)
      return { ...p, pid: undefined, onExit: p.onExit, stderrTail: () => 'spawn sh ENOENT', kill: p.kill }
    }
    await expect(desk.launch({ command: 'app', cwd: '/p', env: {} })).rejects.toThrow('launch: sh could not start (spawn sh ENOENT)')
  })

  it('fails at once, without trying other displays, when Xvfb itself cannot be started', async () => {
    const r = rig()
    const spawn = r.deps.spawn
    r.deps.spawn = (file, args, o) => {
      const p = spawn(file, args, o) as FakeProc
      p.exit('Xvfb could not start: spawn Xvfb ENOENT')
      return { ...p, pid: undefined, onExit: p.onExit, stderrTail: () => '', kill: p.kill }
    }
    await expect(r.desks.start('a')).rejects.toThrow('Xvfb could not start: spawn Xvfb ENOENT')
    expect(r.procs).toHaveLength(1)
  })
})

describe('the Linux desk: fix round 1', () => {
  it('ends the fresh group and rethrows when the launched start time cannot be read', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const real = r.deps.startTime
    r.deps.startTime = async (pid) => (pid === r.procs[0].pid ? real(pid) : Promise.reject(new Error('/proc/stat has no btime line')))
    await expect(desk.launch({ command: 'app', cwd: '/p', env: {} })).rejects.toThrow('/proc/stat has no btime line')
    expect(r.groupsKilled).toEqual([r.procs[1].pid])
  })

  it('still rethrows the start time failure when ending that group fails too, and logs the second failure', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const real = r.deps.startTime
    r.deps.startTime = async (pid) => (pid === r.procs[0].pid ? real(pid) : Promise.reject(new Error('no btime')))
    r.deps.killGroup = async () => {
      throw new Error('EPERM')
    }
    await expect(desk.launch({ command: 'app', cwd: '/p', env: {} })).rejects.toThrow('no btime')
    expect(r.log.some((l) => l.includes(`pid ${r.procs[1].pid} could not be ended: EPERM`))).toBe(true)
  })

  it('types long text in pieces, so each xdotool run stays within the request limit at its delay', async () => {
    const r = rig()
    threeWindows(r)
    const desk = await r.desks.start('a')
    const ascii = 'a'.repeat(450)
    const text = 'b'.repeat(50) + '가'.repeat(200) + '\u{1F600}'.repeat(10)
    await desk.keys({ title: 'astera', text: ascii })
    await desk.keys({ title: 'astera', text })
    const typed = r.runs.filter((x) => x.args[2] === 'type').map((x) => x.args)
    const fast = ['windowfocus', '41', 'type', '--']
    const slow = ['windowfocus', '41', 'type', '--delay', '100', '--']
    expect(typed.map((a) => a.slice(0, -1))).toEqual([fast, fast, slow, slow, slow])
    expect(typed.map((a) => Array.from(a.at(-1)!).length)).toEqual([400, 50, 100, 100, 60])
    expect(typed.map((a) => a.at(-1)).join('')).toBe(ascii + text)
    // About 5 s and 10 s a run: within the 15 s a desk request may run.
    expect(TYPE_CHUNK * 12).toBeLessThanOrEqual(10_000)
    expect(REMAP_CHUNK * REMAP_DELAY_MS).toBeLessThanOrEqual(10_000)
  })

  it('close cancels its wait for Xvfb once Xvfb has exited', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    await desk.close()
    const wait = r.sleeps.find((s) => s.ms === DESK_CLOSE_MS)
    expect(wait?.signal?.aborted).toBe(true)
  })

  it('close still ends Xvfb and resolves when ending an app group fails, and logs it', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const one = await desk.launch({ command: 'a', cwd: '/p', env: {} })
    r.deps.killGroup = async () => {
      throw new Error('EPERM')
    }
    await expect(desk.close()).resolves.toBeUndefined()
    expect(r.procs[0].signals).toEqual(['SIGTERM'])
    expect(r.log.some((l) => l.includes(`pid ${one.pid} could not be ended: EPERM`))).toBe(true)
  })
})

describe('the Linux desk: launch, kill and close', () => {
  it('runs the command through sh on the display, with no Wayland and the x11 hint, and its start time from /proc', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const got = await desk.launch({
      command: 'npm run dev',
      cwd: '/home/me/proj',
      env: {
        PATH: '/usr/bin',
        WAYLAND_DISPLAY: 'wayland-0',
        DISPLAY: ':0',
        ASTERA_APP_CDP_PORT: '9333',
        XDG_RUNTIME_DIR: '/run/user/1000',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus'
      }
    })
    const app = r.procs[1]
    expect(app.file).toBe('sh')
    // A blank line before `wait`, so a command ending in a backslash cannot join it (review M3).
    expect(app.args).toEqual(['-c', 'npm run dev\n\nwait'])
    expect(app.cwd).toBe('/home/me/proj')
    expect(app.env).toEqual({
      PATH: '/usr/bin',
      DISPLAY: ':90',
      ASTERA_APP_CDP_PORT: '9333',
      XDG_RUNTIME_DIR: '/tmp/astera-xrt-1',
      ELECTRON_OZONE_PLATFORM_HINT: 'x11',
      XDG_SESSION_TYPE: 'x11',
      GDK_BACKEND: 'x11',
      QT_QPA_PLATFORM: 'xcb',
      SDL_VIDEODRIVER: 'x11'
    })
    expect(got).toEqual({ pid: app.pid, startedAt: r.starts.get(app.pid!) })
  })

  it('kills a launched group only while its start time matches; a reused pid and an app already gone are left alone', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const got = await desk.launch({ command: 'app', cwd: '/p', env: {} })
    await desk.kill(got.pid, got.startedAt + 60_000)
    expect(r.groupsKilled).toEqual([])
    expect(r.log.some((l) => l.includes(`start time mismatch: pid ${got.pid}`))).toBe(true)
    await desk.kill(got.pid, got.startedAt + 1_500)
    expect(r.groupsKilled).toEqual([got.pid])
    await expect(desk.kill(got.pid, got.startedAt)).resolves.toBeUndefined()
    expect(r.groupsKilled).toEqual([got.pid])
    expect(r.log.some((l) => l.includes(`pid ${got.pid} is not running`))).toBe(true)
  })

  it('close ends every launched group, then Xvfb, and frees the display', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const one = await desk.launch({ command: 'a', cwd: '/p', env: {} })
    const two = await desk.launch({ command: 'b', cwd: '/p', env: {} })
    await desk.close()
    expect(r.groupsKilled).toEqual([one.pid, two.pid])
    expect(r.procs[0].signals).toEqual(['SIGTERM'])
    expect(desk.alive()).toBe(false)
    await r.desks.start('b')
    expect(r.procs.at(-1)!.args[0]).toBe(':90')
  })

  it('close after the app exited by itself still ends Xvfb, and rejects nothing', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const one = await desk.launch({ command: 'a', cwd: '/p', env: {} })
    r.starts.delete(one.pid)
    await expect(desk.close()).resolves.toBeUndefined()
    expect(r.groupsKilled).toEqual([])
    expect(r.procs[0].signals).toEqual(['SIGTERM'])
  })
})

describe('the Linux desk: windows, shots and keys', () => {
  it("lists the display's windows: a Hangul title intact, a window with no pid as pid 0, one that closed meanwhile left out (Review Focus 4)", async () => {
    const r = rig()
    threeWindows(r)
    const desk = await r.desks.start('a')
    expect(await desk.windows()).toEqual([
      { hwnd: 41, title: 'Astera 픽스처 창', className: '', pid: 4242, width: 900, height: 700, visible: true },
      { hwnd: 42, title: 'no pid', className: '', pid: 0, width: 200, height: 100, visible: true }
    ])
    expect(r.runs.find((x) => x.args[0] === 'search')).toMatchObject({ file: 'xdotool', args: ['search', '--onlyvisible', '--name', ''] })
    expect(r.runs.every((x) => x.env.DISPLAY === ':90' && x.env.WAYLAND_DISPLAY === undefined)).toBe(true)
  })

  it('lists nothing when xdotool finds no window (it exits 1)', async () => {
    const r = rig()
    r.xdo((args) => (args[0] === 'search' ? exit1() : undefined))
    expect(await (await r.desks.start('a')).windows()).toEqual([])
  })

  it('photographs the largest titled window, scaled for a frame, and reads the size from the image', async () => {
    const r = rig()
    threeWindows(r)
    r.answers.push((file) => (file === 'import' ? jpeg(900, 700) : undefined))
    const desk = await r.desks.start('a')
    expect(await desk.shot({ format: 'jpeg', maxWidth: 960 })).toEqual({ data: jpeg(900, 700).toString('base64'), width: 900, height: 700, title: 'Astera 픽스처 창' })
    expect(r.runs.at(-1)).toMatchObject({ file: 'import', args: ['-display', ':90', '-window', '41', '-resize', '960x>', 'jpeg:-'] })
  })

  it('photographs the whole display when no window has a title (R2), and throws the Windows words for a title nothing matches', async () => {
    const r = rig()
    r.xdo((args) => (args[0] === 'search' ? exit1() : undefined))
    r.answers.push((file) => (file === 'import' ? png(1920, 1080) : undefined))
    const desk = await r.desks.start('a')
    expect(await desk.shot({ format: 'png' })).toMatchObject({ width: 1920, height: 1080, title: '' })
    expect(r.runs.at(-1)!.args).toEqual(['-display', ':90', '-window', 'root', 'png:-'])
    await expect(desk.shot({ title: 'Import', format: 'png' })).rejects.toThrow('no window titled "Import" is showing on this desktop')
  })

  it('types into a window by focusing it and sending XTEST keys (R1), and maps the named keys', async () => {
    const r = rig()
    threeWindows(r)
    const desk = await r.desks.start('a')
    await desk.keys({ title: '픽스처', text: '-hi 안녕' })
    await desk.keys({ title: 'astera', key: 'Enter' })
    expect(r.runs.filter((x) => x.args[0] === 'windowfocus').map((x) => x.args)).toEqual([
      ['windowfocus', '41', 'type', '--delay', '100', '--', '-hi 안녕'],
      ['windowfocus', '41', 'key', '--clearmodifiers', 'Return']
    ])
    await expect(desk.keys({ title: 'nothing like it', text: 'x' })).rejects.toThrow('no window titled "nothing like it"')
    await expect(desk.keys({ title: 'Astera', key: 'F13' })).rejects.toThrow('unknown key F13')
  })

  it('knows every key name press() knows', () => {
    for (const k of NAMED_KEYS) expect(XDOTOOL_KEYS[k], k).toBeTruthy()
  })
})

describe('the Linux desk: pure parts', () => {
  it('points the env at the display and drops Wayland, so an app started from a Wayland desktop cannot reach its screen (ruling F5)', () => {
    const wayland = { WAYLAND_DISPLAY: 'w', WAYLAND_SOCKET: '5', XDG_SESSION_TYPE: 'wayland', GDK_BACKEND: 'wayland', QT_QPA_PLATFORM: 'wayland', SDL_VIDEODRIVER: 'wayland' }
    const person = { XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }
    expect(displayEnv({ A: '1', DISPLAY: ':0', GONE: undefined, ...wayland, ...person }, 93, '/tmp/astera-xrt-x')).toEqual({
      A: '1',
      DISPLAY: ':93',
      XDG_RUNTIME_DIR: '/tmp/astera-xrt-x',
      ELECTRON_OZONE_PLATFORM_HINT: 'x11',
      XDG_SESSION_TYPE: 'x11',
      GDK_BACKEND: 'x11',
      QT_QPA_PLATFORM: 'xcb',
      SDL_VIDEODRIVER: 'x11'
    })
  })

  it('gives every desk tool the same X11 only env (ruling F5)', async () => {
    const r = rig()
    r.xdo((args) => (args[0] === 'search' ? exit1() : undefined))
    r.answers.push((file) => (file === 'import' ? png(1920, 1080) : undefined))
    r.deps.hostEnv.XDG_SESSION_TYPE = 'wayland'
    const desk = await r.desks.start('a')
    await desk.shot({ format: 'png' })
    expect(r.runs.length).toBeGreaterThan(0)
    for (const x of r.runs) expect(x.env).toMatchObject({ DISPLAY: ':90', XDG_SESSION_TYPE: 'x11', GDK_BACKEND: 'x11', XDG_RUNTIME_DIR: '/tmp/astera-xrt-1' })
    expect(r.runs.every((x) => !('WAYLAND_DISPLAY' in x.env) && !('DBUS_SESSION_BUS_ADDRESS' in x.env))).toBe(true)
  })

  it('types text the US keyboard has keys for at the default delay, and text with anything else in it slowly, all of it', () => {
    expect(typeRuns('echo hi\tthere\n')).toEqual([['type', '--', 'echo hi\tthere\n']])
    expect(typeRuns('hi 한글 입력\n')).toEqual([['type', '--delay', String(REMAP_DELAY_MS), '--', 'hi 한글 입력\n']])
    expect(typeRuns('x\u{1F600}')).toEqual([['type', '--delay', String(REMAP_DELAY_MS), '--', 'x\u{1F600}']])
    expect(typeRuns('café')).toEqual([['type', '--delay', String(REMAP_DELAY_MS), '--', 'café']])
    expect(typeRuns('')).toEqual([])
  })

  it('reads geometry, and image sizes from PNG and JPEG headers', () => {
    expect(parseGeometry('WINDOW=1\nX=0\nY=0\nWIDTH=640\nHEIGHT=480\nSCREEN=0\n')).toEqual({ x: 0, y: 0, width: 640, height: 480 })
    expect(parseGeometry('WINDOW=1\nX=510\nY=-4\nWIDTH=900\nHEIGHT=700\n')).toEqual({ x: 510, y: -4, width: 900, height: 700 })
    expect(parseGeometry('nonsense')).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(imageSize(png(3, 4))).toEqual({ width: 3, height: 4 })
    expect(imageSize(jpeg(960, 540))).toEqual({ width: 960, height: 540 })
    expect(imageSize(Buffer.from('not an image'))).toEqual({ width: 0, height: 0 })
  })

  it('picks the largest showing titled window, matching the title case blind', () => {
    const w = (hwnd: number, title: string, width: number, visible = true): DeskWindow => ({ hwnd, title, className: '', pid: 1, width, height: 100, visible })
    const list = [w(1, 'Small Import', 100), w(2, 'Big import', 500), w(3, '', 900), w(4, 'Hidden Import', 900, false)]
    expect(pickWindow(list)?.hwnd).toBe(2)
    expect(pickWindow(list, 'IMPORT')?.hwnd).toBe(2)
    expect(pickWindow(list, 'small')?.hwnd).toBe(1)
    expect(pickWindow(list, 'nope')).toBeNull()
  })
})

describe('the Linux desk: a private runtime folder (review I1)', () => {
  it("gives each desk its own runtime folder and no session bus, so the person's portals, notifications, tray, Wayland and audio sockets are out of reach", async () => {
    const r = rig()
    const a = await r.desks.start('a')
    const b = await r.desks.start('b')
    await a.launch({ command: 'app', cwd: '/p', env: { XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' } })
    await b.launch({ command: 'app', cwd: '/p', env: {} })
    expect(r.made).toEqual(['/tmp/astera-xrt-1', '/tmp/astera-xrt-2'])
    const [, , appA, appB] = r.procs
    expect(appA.env.XDG_RUNTIME_DIR).toBe('/tmp/astera-xrt-1')
    expect(appB.env.XDG_RUNTIME_DIR).toBe('/tmp/astera-xrt-2')
    expect('DBUS_SESSION_BUS_ADDRESS' in appA.env).toBe(false)
    // Xvfb itself keeps the Host's own env: it opens no bus and needs none of this.
    expect(r.procs[0].env.XDG_RUNTIME_DIR).toBe('/run/user/1000')
  })

  it('removes the folder on close', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    expect([...r.dirs]).toEqual(['/tmp/astera-xrt-1'])
    await desk.close()
    expect(r.dirs.size).toBe(0)
  })

  it('removes the folder when Xvfb dies by itself, since no close may follow', async () => {
    const r = rig()
    await r.desks.start('a')
    r.procs[0].exit('exited SIGKILL')
    await Promise.resolve()
    expect(r.dirs.size).toBe(0)
  })

  it('ends that Xvfb, frees the number, and fails when the folder cannot be made', async () => {
    const r = rig()
    const real = r.deps.makeRuntimeDir
    r.deps.makeRuntimeDir = async () => {
      throw new Error('ENOSPC: no space left on device')
    }
    await expect(r.desks.start('a')).rejects.toThrow('ENOSPC')
    expect(r.procs[0].signals).toEqual(['SIGKILL'])
    r.deps.makeRuntimeDir = real
    await r.desks.start('b')
    expect(r.procs[1].args[0]).toBe(':90')
  })

  it('still closes, and logs, when the folder cannot be removed', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    r.deps.removeDir = async () => {
      throw new Error('EBUSY')
    }
    await expect(desk.close()).resolves.toBeUndefined()
    expect(r.procs[0].signals).toEqual(['SIGTERM'])
    expect(r.log.some((l) => l.includes('/tmp/astera-xrt-1') && l.includes('EBUSY'))).toBe(true)
  })
})

describe('the Linux desk: real deps', () => {
  it('makes a real runtime folder only its owner may open, under the temp folder, and removes it', async () => {
    const d = realLinuxDeskDeps({ hostEnv: {}, log: () => {} })
    const dir = await d.makeRuntimeDir()
    try {
      expect(path.basename(dir).startsWith('astera-xrt-')).toBe(true)
      expect(path.dirname(dir)).toBe(path.resolve(os.tmpdir()))
      const st = await fs.stat(dir)
      expect(st.isDirectory()).toBe(true)
      if (process.platform !== 'win32') expect(st.mode & 0o777).toBe(0o700)
    } finally {
      await d.removeDir(dir)
    }
    await expect(fs.stat(dir)).rejects.toThrow()
    await expect(d.removeDir(dir)).resolves.toBeUndefined()
  })

  it('ends a real sleep, and clears its timer, when its signal aborts', async () => {
    const d = realLinuxDeskDeps({ hostEnv: {}, log: () => {} })
    const stop = new AbortController()
    const t0 = Date.now()
    const done = d.sleep(60_000, stop.signal)
    stop.abort()
    await done
    await d.sleep(60_000, stop.signal)
    expect(Date.now() - t0).toBeLessThan(1_000)
  })
})

describe('the Linux desk: fit', () => {
  it('moves the largest titled window to the top left, sizes it, never past the display, and answers its geometry', async () => {
    const r = rig()
    threeWindows(r)
    const desk = await r.desks.start('a')
    expect(await desk.fit!({ width: 2400, height: 900 })).toEqual({ width: 900, height: 700 })
    expect(r.runs.find((x) => x.args[0] === 'windowmove')!.args).toEqual(['windowmove', '41', '0', '0', 'windowsize', '41', '1920', '900'])
    await expect(desk.fit!({ title: 'nothing like it', width: 800, height: 600 })).rejects.toThrow('no window titled "nothing like it"')
  })
})
