// The Linux Desk (Linux and macOS design, Linux Desk): one Xvfb per workspace on a display nobody looks
// at, the app launched on it through sh in a process group of its own, its windows listed and typed
// into with xdotool and photographed with ImageMagick's import. It needs no interactive session (L2):
// Xvfb is the display. Its clipboard is Xvfb's own, not the person's.
//
// Every process and file it touches arrives in `LinuxDeskDeps`, so the tests drive it on any OS;
// `realLinuxDeskDeps` is the real one.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DeskHandle, DeskPointer } from '../../core/workspace/helpers'
import { START_TIME_TOLERANCE_MS } from '../../core/workspace/lifecycle'
import { DESK_CLOSE_MS, DESK_READY_MS, type DeskLaunched, type DeskShot, type DeskWindow } from '../../core/workspace/protocol'
import { execText, killGroup, linuxStartTimes, realLinuxProcFs, runTool, spawnDetached, type RunTool, type SpawnDetached, type SpawnedProc } from './posixProc'

export const FIRST_DISPLAY = 90
export const LAST_DISPLAY = 189
export const XVFB_SCREEN = '1920x1080x24'
/** Where the desk puts the display's pointer once Xvfb is up: its last pixel, bottom right. Xvfb
 *  starts the pointer in the middle of the screen, which is where an Electron window opens with no
 *  window manager to place it. Left there, the pointer is inside the app's window, and every time
 *  the window is mapped, moved or resized over it X tells the app the pointer entered or moved, with
 *  no button down. Chromium passes that to the page as a mouse move without buttons, which ends the
 *  press CDP made for drag(), and the drag never starts. Measured on Xvfb in ubuntu:24.04: a window
 *  mapped between the press and the move failed 5 of 5 drags with the pointer in the middle and none
 *  of 5 with it here; a real pointer move over the window between them failed 5 of 5 too. It is the
 *  one way found for drag() to fail on Linux only, as it did in CI run 36307554502. Only a window that
 *  covers the whole screen reaches this corner. */
export const PARKED_POINTER = ((): { x: number; y: number } => {
  const [w, h] = XVFB_SCREEN.split('x').map(Number)
  return { x: w - 1, y: h - 1 }
})()
/** How many display numbers one desk tries when Xvfb exits before it reports ready (R4). */
export const DISPLAY_TRIES = 3
const POLL_MS = 50
/** Characters per `xdotool type` run of keyboard text (KEYBOARD_TEXT). At xdotool's default 12 ms per
 *  character, 400 take about 5 s, well inside the 15 s a desk request may run (DESK_REQUEST_MS). */
export const TYPE_CHUNK = 400
/** What Xvfb's US keyboard has a key for: printable ASCII, newline and tab. */
const KEYBOARD_TEXT = /^[\x20-\x7e\n\t]$/
/** The per character delay, in ms, for text with any other character in it (Hangul, emoji, accented
 *  letters; typeRuns). xdotool types such a character by binding it to a spare key, pressing that key
 *  and unbinding it again, and Chromium, which reads the new binding only after it is told the
 *  keyboard changed, loses the character when the unbinding comes first. Measured on Xvfb in ubuntu:24.04 with 'hi 한글 입력': at the default 12 ms
 *  7 of 30 runs lost a character, at 60 ms and at 100 ms none of 30 did. */
export const REMAP_DELAY_MS = 100
/** Characters per run at REMAP_DELAY_MS: about 10 s, inside DESK_REQUEST_MS. */
export const REMAP_CHUNK = 100
/** How long Chromium is given to read a keyboard map the desk uploaded, before the typing that needs
 *  it and again after it, before the map goes back (bindKeysyms). */
export const KEYMAP_SETTLE_MS = 300
/** Moves between the press and the target in a real pointer drag (pressArgs). */
export const DRAG_STEPS = 5
/** The pause after each move, in seconds, as xdotool's `sleep` takes it. */
const DRAG_STEP_S = '0.05'
/** Chromium counts a press this soon after the last one, at the same place, as a double click, and a
 *  double click starts no drag: a second real drag waits out the rest of this after the first. */
export const PRESS_GAP_MS = 700
/** The fd Xvfb reports its display number on once it accepts connections (-displayfd). */
const READY_FD = 3

/** The key names press() and keys() take (NAMED_KEYS, helpers.ts), as X keysyms. */
export const XDOTOOL_KEYS: Record<string, string> = {
  Enter: 'Return',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'BackSpace',
  Delete: 'Delete',
  Space: 'space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'Prior',
  PageDown: 'Next'
}

export interface LinuxDeskDeps {
  /** The Host's environment, the base Xvfb and every tool run with. */
  hostEnv: Record<string, string | undefined>
  spawn: SpawnDetached
  run: RunTool
  exists(p: string): Promise<boolean>
  /** A fresh folder only this user may open (mode 0700), the desk's own XDG_RUNTIME_DIR. */
  makeRuntimeDir(): Promise<string>
  /** Removes a folder and what is in it; a folder already gone is no error. */
  removeDir(p: string): Promise<void>
  /** Writes a text file (UTF-8), replacing one that is there. */
  writeFile(p: string, text: string): Promise<void>
  /** A live pid's start time in epoch ms from /proc, or null when it is gone. */
  startTime(pid: number): Promise<number | null>
  killGroup(pid: number): Promise<void>
  /** Resolves after ms, or at once when `signal` aborts (its timer cleared). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  now(): number
  log(m: string): void
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const stringEnv = (env: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v
  return out
}

/** The env a process on display :n sees: its own, pointed at the display, never at a Wayland one, and
 *  Electron told to speak X11 (spec, Launch). Electron 38 and later no longer read
 *  ELECTRON_OZONE_PLATFORM_HINT, and with XDG_SESSION_TYPE=wayland left in place Chromium's auto
 *  selection and GTK could still pick Wayland, where libwayland falls back to `wayland-0`: the person's
 *  own screen. So the session type and GTK's backend say x11 too (preflight ruling F5). Any command can
 *  be launched, not only Electron, so Qt and SDL are pointed at X11 as well, and WAYLAND_SOCKET (an
 *  inherited compositor connection libwayland takes before anything else) goes with WAYLAND_DISPLAY.
 *
 *  The person's session bus and runtime folder go too (review I1). Over DBUS_SESSION_BUS_ADDRESS an app
 *  on Xvfb could still open a portal file chooser, a notification or a tray icon on the person's
 *  screen, and libdbus and GDBus fall back to `$XDG_RUNTIME_DIR/bus` without it. That folder also holds
 *  `wayland-0` and the PipeWire and Pulse sockets. So XDG_RUNTIME_DIR is the desk's own empty folder. */
export function displayEnv(env: Record<string, string | undefined>, display: number, runtimeDir: string): Record<string, string> {
  const out = stringEnv(env)
  delete out.WAYLAND_DISPLAY
  delete out.WAYLAND_SOCKET
  delete out.DBUS_SESSION_BUS_ADDRESS
  out.XDG_RUNTIME_DIR = runtimeDir
  out.DISPLAY = `:${display}`
  out.ELECTRON_OZONE_PLATFORM_HINT = 'x11'
  out.XDG_SESSION_TYPE = 'x11'
  out.GDK_BACKEND = 'x11'
  out.QT_QPA_PLATFORM = 'xcb'
  out.SDL_VIDEODRIVER = 'x11'
  return out
}

/** `text` as the `xdotool type` arguments that type it, never splitting a surrogate pair: keyboard text
 *  at the default delay in runs of TYPE_CHUNK, and text with any other character in it all at
 *  REMAP_DELAY_MS in runs of REMAP_CHUNK. All of it, not only those characters: typed in runs of their
 *  own right after keyboard text typed at the default delay, the first of them was still lost now and
 *  then (1 of 30 runs), and never when the whole text went slowly (0 of 30). */
export function typeRuns(text: string): string[][] {
  const chars = Array.from(text)
  const keyboard = chars.every((ch) => KEYBOARD_TEXT.test(ch))
  const size = keyboard ? TYPE_CHUNK : REMAP_CHUNK
  const head = keyboard ? ['type', '--'] : ['type', '--delay', String(REMAP_DELAY_MS), '--']
  const out: string[][] = []
  for (let i = 0; i < chars.length; i += size) out.push([...head, chars.slice(i, i + size).join('')])
  return out
}

/** What the keyboard has no key for: every character of `text` that is not KEYBOARD_TEXT, once each,
 *  in order. */
export function specialChars(text: string): string[] {
  return [...new Set(Array.from(text).filter((ch) => !KEYBOARD_TEXT.test(ch)))]
}

/** The keycode names an `xkbcomp -xkb` dump defines in xkb_keycodes and binds nothing to in
 *  xkb_symbols: keys this keyboard has and never types with, free to bind. */
export function freeKeycodes(xkb: string): string[] {
  const kc = xkb.indexOf('xkb_keycodes')
  const types = xkb.indexOf('xkb_types', kc)
  const sym = xkb.indexOf('xkb_symbols')
  if (kc < 0 || types < 0 || sym < 0) return []
  const names = [...xkb.slice(kc, types).matchAll(/^\s*<([A-Za-z0-9_+-]+)>\s*=\s*\d+\s*;/gm)].map((m) => m[1])
  const used = new Set([...xkb.slice(sym).matchAll(/\bkey\s+<([A-Za-z0-9_+-]+)>/g)].map((m) => m[1]))
  return names.filter((n) => !used.has(n))
}

/** The dump with each character bound, at its first level, to the free keycode next to it, as its
 *  Unicode keysym: the lines go at the end of xkb_symbols. The dump itself when there is no
 *  xkb_symbols to add to. */
export function withKeysyms(xkb: string, bind: Array<{ keycode: string; ch: string }>): string {
  const sym = xkb.indexOf('xkb_symbols')
  const end = sym < 0 ? -1 : xkb.indexOf('\n};', sym)
  if (end < 0) return xkb
  const lines = bind.map((b) => `    key <${b.keycode}> { [ U${(b.ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')} ] };`)
  return `${xkb.slice(0, end)}\n${lines.join('\n')}${xkb.slice(end)}`
}

/** `text` in pieces of at most TYPE_CHUNK characters, each with at most `free` characters the
 *  keyboard has no key for, never splitting a surrogate pair. */
export function keymapPieces(text: string, free: number): string[] {
  const out: string[] = []
  let piece: string[] = []
  let special = new Set<string>()
  for (const ch of Array.from(text)) {
    const extra = !KEYBOARD_TEXT.test(ch) && !special.has(ch)
    if (piece.length === TYPE_CHUNK || (extra && special.size === free)) {
      out.push(piece.join(''))
      piece = []
      special = new Set()
    }
    if (!KEYBOARD_TEXT.test(ch)) special.add(ch)
    piece.push(ch)
  }
  if (piece.length > 0) out.push(piece.join(''))
  return out
}

/** `xdotool getwindowgeometry --shell`: WINDOW=, X=, Y=, WIDTH=, HEIGHT=, SCREEN= lines. */
export function parseGeometry(text: string): { x: number; y: number; width: number; height: number } {
  const num = (k: string): number => Number(new RegExp(`^${k}=(-?\\d+)$`, 'm').exec(text)?.[1] ?? 0)
  return { x: num('X'), y: num('Y'), width: num('WIDTH'), height: num('HEIGHT') }
}

/** The env xdotool runs with: `env` with a UTF-8 locale. `xdotool type` decodes its text through the
 *  locale and refuses anything but ASCII under the C locale ("Invalid multi-byte sequence"), which is
 *  what a Host started with no LANG or LC_* gets. A UTF-8 locale the Host already has is kept. */
export function utf8Env(env: Record<string, string>): Record<string, string> {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || ''
  return /utf-?8/i.test(locale) ? env : { ...env, LC_ALL: 'C.UTF-8' }
}

/** One `xdotool` run that presses at `from` and moves in DRAG_STEPS steps to `to`, both in screen
 *  pixels, with a pause after each so Chromium sees every move as its own event. */
export function pressArgs(from: { x: number; y: number }, to: { x: number; y: number }): string[] {
  const at = (x: number, y: number): string[] => ['mousemove', String(Math.round(x)), String(Math.round(y)), 'sleep', DRAG_STEP_S]
  const out = [...at(from.x, from.y), 'mousedown', '1', 'sleep', DRAG_STEP_S]
  for (let i = 1; i <= DRAG_STEPS; i++) out.push(...at(from.x + ((to.x - from.x) * i) / DRAG_STEPS, from.y + ((to.y - from.y) * i) / DRAG_STEPS))
  return out
}

/** Width and height of a PNG (its IHDR) or a JPEG (its first SOF marker); zeros for anything else. */
export function imageSize(b: Buffer): { width: number; height: number } {
  if (b.length >= 24 && b[0] === 0x89 && b.toString('ascii', 12, 16) === 'IHDR') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) break
      const marker = b[i + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }
      i += 2 + b.readUInt16BE(i + 2)
    }
  }
  return { width: 0, height: 0 }
}

/** The largest showing window with a title, containing `title` when one is given (case blind): the
 *  Windows helper's Find rule, so windowShot and keys pick the same window on both (R2). */
export function pickWindow(list: readonly DeskWindow[], title?: string): DeskWindow | null {
  const want = title?.toLowerCase()
  let best: DeskWindow | null = null
  for (const w of list) {
    if (!w.visible || w.width <= 0 || w.height <= 0 || w.title === '') continue
    if (want !== undefined && !w.title.toLowerCase().includes(want)) continue
    if (!best || w.width * w.height > best.width * best.height) best = w
  }
  return best
}

const noWindow = (title: string): Error => new Error(`no window titled "${title}" is showing on this desktop`)

export function createLinuxDesks(d: LinuxDeskDeps): { start(name: string): Promise<DeskHandle> } {
  /** Display numbers this Host holds or is probing (R4). */
  const taken = new Set<number>()

  const reserve = async (): Promise<number> => {
    for (let n = FIRST_DISPLAY; n <= LAST_DISPLAY; n++) {
      if (taken.has(n)) continue
      // Reserved before the probes' awaits, so a desk starting at the same moment skips it (Review
      // Focus 1).
      taken.add(n)
      if ((await d.exists(`/tmp/.X11-unix/X${n}`)) || (await d.exists(`/tmp/.X${n}-lock`))) {
        taken.delete(n)
        continue
      }
      return n
    }
    throw new Error(`no free X display between :${FIRST_DISPLAY} and :${LAST_DISPLAY}`)
  }

  /** One Xvfb on :n, ready once it writes n to its -displayfd pipe, which only this Xvfb can do: a
   *  socket file for :n proves nothing, since another X server may have made it between the probe and
   *  this spawn (fix round 1). `taken` when it exits first (the number went to someone else); a throw
   *  when it never reports within the ready limit. -noreset keeps what the desk set up when the last
   *  client leaves: without it Xvfb resets then, and the pointer the desk parked (PARKED_POINTER) is
   *  back in the middle of the screen before the app connects, and again after every relaunch. */
  const startXvfb = async (n: number): Promise<{ proc: SpawnedProc } | { taken: string }> => {
    const proc = d.spawn('Xvfb', [`:${n}`, '-screen', '0', XVFB_SCREEN, '-nolisten', 'tcp', '-noreset', '-displayfd', String(READY_FD)], {
      env: stringEnv(d.hostEnv),
      stderr: true,
      readyFd: true
    })
    const reported = (): boolean => (proc.readyText?.() ?? '').split('\n').some((l) => l.trim() === String(n))
    const st = { exited: null as string | null }
    proc.onExit((why) => {
      st.exited = why
    })
    const until = d.now() + DESK_READY_MS
    for (;;) {
      if (st.exited !== null) {
        // No pid: Xvfb itself could not be started (not installed, not executable). Another display
        // number would not help.
        if (proc.pid === undefined) throw new Error(st.exited)
        const tail = proc.stderrTail()
        return { taken: tail ? `${st.exited}: ${tail}` : st.exited }
      }
      if (reported()) return { proc }
      if (d.now() >= until) {
        proc.kill('SIGKILL')
        throw new Error(`Xvfb :${n} did not open its display within ${DESK_READY_MS / 1000} s`)
      }
      await d.sleep(POLL_MS)
    }
  }

  const start = async (name: string): Promise<DeskHandle> => {
    let xvfb: SpawnedProc | null = null
    let display = 0
    let lastWhy = ''
    for (let i = 0; i < DISPLAY_TRIES && xvfb === null; i++) {
      display = await reserve()
      let r: { proc: SpawnedProc } | { taken: string }
      try {
        r = await startXvfb(display)
      } catch (err) {
        taken.delete(display)
        throw err
      }
      if ('proc' in r) xvfb = r.proc
      else {
        // Freed at once: the other Host's lock file keeps the next probe off it.
        taken.delete(display)
        lastWhy = r.taken
        d.log(`Xvfb :${display} exited before it was ready (${r.taken}); trying the next display`)
      }
    }
    if (xvfb === null || xvfb.pid === undefined) throw new Error(`Xvfb could not start: ${lastWhy || 'no reason given'}`)
    const proc = xvfb
    const pid = xvfb.pid
    // From /proc, never the clock: the leftover sweep compares this with the kernel's own record.
    const readAt = await d.startTime(pid).catch((err: unknown) => {
      proc.kill('SIGKILL')
      taken.delete(display)
      throw err
    })
    if (readAt === null) {
      proc.kill('SIGKILL')
      taken.delete(display)
      throw new Error(`Xvfb :${display} ended before its start time could be read`)
    }
    const startedAt = readAt
    // Made after Xvfb is up, so a display that is taken or never ready leaves no folder behind. Its
    // name is `astera-xrt-` and random under the temp folder: one a crash leaves is empty and harmless.
    const runtimeDir = await d.makeRuntimeDir().catch((err: unknown) => {
      proc.kill('SIGKILL')
      taken.delete(display)
      throw err
    })
    let removing: Promise<void> | null = null
    const dropRuntimeDir = (): Promise<void> =>
      (removing ??= d.removeDir(runtimeDir).catch((err: unknown) => d.log(`desktop ${name}: ${runtimeDir} could not be removed: ${messageOf(err)}`)))
    const env = displayEnv(d.hostEnv, display, runtimeDir)
    const launched = new Map<number, number>()
    const exitCbs: Array<(why: string) => void> = []
    const st = { dead: null as string | null }
    let exitedResolve!: () => void
    const exited = new Promise<'exited'>((resolve) => {
      exitedResolve = () => resolve('exited')
    })
    proc.onExit((why) => {
      st.dead = why
      taken.delete(display)
      exitedResolve()
      // An Xvfb that dies by itself gets no close: the manager only ends the recorded app.
      void dropRuntimeDir()
      for (const cb of exitCbs) {
        try {
          cb(why)
        } catch (err) {
          d.log(`desktop ${name}: an Xvfb exit listener threw: ${String(err)}`)
        }
      }
    })
    d.log(`desktop ${name}: Xvfb :${display} is ready (pid ${pid})`)

    const live = (): void => {
      if (st.dead !== null) throw new Error(`the virtual display ended (${st.dead})`)
    }
    const xdoEnv = utf8Env(env)
    const xdotool = (args: string[]): Promise<Buffer> => d.run('xdotool', args, xdoEnv)
    const line = (b: Buffer): string => b.toString('utf8').replace(/\n$/, '')
    // Before anything is launched, so no window is ever mapped under it (PARKED_POINTER). A desk
    // whose pointer could not be moved still works; only drag() may then be cut short.
    await xdotool(['mousemove', String(PARKED_POINTER.x), String(PARKED_POINTER.y)]).catch((err: unknown) =>
      d.log(`desktop ${name}: the pointer could not be moved out of the way: ${messageOf(err)}`)
    )

    const windows = async (): Promise<DeskWindow[]> => {
      live()
      const ids = await xdotool(['search', '--onlyvisible', '--name', '']).then(
        (b) =>
          b
            .toString('utf8')
            .split('\n')
            .map((s) => s.trim())
            .filter((s) => /^\d+$/.test(s)),
        (err: { code?: unknown }) => {
          if (err?.code === 1) return [] as string[]
          throw err
        }
      )
      const out: DeskWindow[] = []
      for (const id of ids) {
        // A window that closes between the search and these questions is left out (Review Focus 4).
        const w = await Promise.all([
          xdotool(['getwindowname', id]).then(line),
          xdotool(['getwindowgeometry', '--shell', id]).then((b) => parseGeometry(b.toString('utf8'))),
          xdotool(['getwindowpid', id]).then(
            (b) => Number(line(b).trim()) || 0,
            () => 0
          )
        ]).catch(() => null)
        if (w) out.push({ hwnd: Number(id), title: w[0], className: '', pid: w[2], width: w[1].width, height: w[1].height, visible: true })
      }
      return out
    }

    /** Types text that has characters the keyboard has no key for with those characters bound to
     *  free keys first, for the whole of each piece, then the map put back: xdotool then finds every
     *  character on a key and binds nothing while it types, so there is no binding for Chromium to read
     *  late (REMAP_DELAY_MS). On Xvfb in ubuntu:24.04 at 2 CPUs, 90 of 90 typings came out whole this
     *  way, at the default delay. False, having typed nothing, when the map cannot be read or has no
     *  free key; the caller then types the slow way. */
    const typeBound = async (id: string, text: string): Promise<boolean> => {
      let original: string
      try {
        original = (await d.run('xkbcomp', ['-w', '0', '-xkb', `:${display}`, '-'], env)).toString('utf8')
      } catch (err) {
        d.log(`desktop ${name}: the keyboard map could not be read (${messageOf(err)}); typing slowly instead`)
        return false
      }
      const free = freeKeycodes(original)
      if (free.length === 0) return false
      const file = path.posix.join(runtimeDir, 'keymap.xkb')
      const upload = async (xkb: string): Promise<void> => {
        await d.writeFile(file, xkb)
        await d.run('xkbcomp', ['-w', '0', file, `:${display}`], env)
      }
      try {
        for (const piece of keymapPieces(text, free.length)) {
          await upload(withKeysyms(original, specialChars(piece).map((ch, i) => ({ keycode: free[i], ch }))))
          await d.sleep(KEYMAP_SETTLE_MS)
          await xdotool(['windowfocus', id, 'type', '--', piece])
          await d.sleep(KEYMAP_SETTLE_MS)
        }
      } finally {
        await upload(original).catch((err: unknown) => d.log(`desktop ${name}: the keyboard map could not be put back: ${messageOf(err)}`))
      }
      return true
    }

    const park = ['mousemove', String(PARKED_POINTER.x), String(PARKED_POINTER.y)]
    let lastPressAt = -Infinity
    /** drag()'s fallback (DeskPointer, helpers.ts): real X input on this display, which only this
     *  workspace uses. The window's origin comes from xdotool, the points in it from the page. */
    const pointer: DeskPointer = {
      press: async (o) => {
        const w = pickWindow(await windows(), o.title || undefined)
        if (!w) throw noWindow(o.title)
        const g = parseGeometry((await xdotool(['getwindowgeometry', '--shell', String(w.hwnd)])).toString('utf8'))
        // A point off the window would press on whatever lies under it, or on nothing (CI run
        // 36312079513 pressed at 450,101, above the window at 510,190).
        for (const pt of [o.from, o.to])
          if (!(pt.x >= 0 && pt.y >= 0 && pt.x < g.width && pt.y < g.height))
            throw new Error(`the point ${pt.x},${pt.y} is outside the ${g.width}x${g.height} window "${w.title}", so the display's pointer was not pressed`)
        const wait = lastPressAt + PRESS_GAP_MS - d.now()
        if (wait > 0) await d.sleep(wait)
        lastPressAt = d.now()
        const from = { x: g.x + o.from.x, y: g.y + o.from.y }
        const to = { x: g.x + o.to.x, y: g.y + o.to.y }
        d.log(`desktop ${name}: dragging with the display's pointer from ${from.x},${from.y} to ${to.x},${to.y} (window ${w.hwnd} at ${g.x},${g.y})`)
        await xdotool(pressArgs(from, to))
      },
      release: async () => {
        await xdotool(['mouseup', '1', ...park])
      }
    }

    const kill = async (p: number, at: number): Promise<void> => {
      const liveAt = await d.startTime(p)
      if (liveAt === null) {
        launched.delete(p)
        d.log(`desktop ${name}: pid ${p} is not running`)
        return
      }
      if (Math.abs(liveAt - at) > START_TIME_TOLERANCE_MS) {
        launched.delete(p)
        d.log(`desktop ${name}: start time mismatch: pid ${p} started at ${liveAt}, not ${at}; left alone`)
        return
      }
      await d.killGroup(p)
      launched.delete(p)
    }

    return {
      name,
      pid,
      startedAt,
      alive: () => st.dead === null,
      onExit: (cb) => {
        exitCbs.push(cb)
      },
      launch: async (a): Promise<DeskLaunched> => {
        live()
        // `wait` keeps sh, the group's leader, alive while anything the command put in the background
        // still runs, so the group always has a leader with a real start time to kill by (fix round 1).
        // A newline, not `;`, so a command ending in a comment still reaches it, and a blank line, so a
        // command ending in a backslash continues onto the empty line, not onto `wait` (review M3).
        const child = d.spawn('sh', ['-c', `${a.command}\n\nwait`], { env: displayEnv(a.env, display, runtimeDir), cwd: a.cwd })
        if (child.pid === undefined) throw new Error(`launch: sh could not start (${child.stderrTail() || 'no reason given'})`)
        const cpid = child.pid
        // From /proc, never the clock. A command gone already (it exited at once) is recorded with 0,
        // which no live process matches, so a later kill or sweep never reaches a reused pid. When the
        // read itself fails the fresh group is ended here, since nothing else will know to (fix round 1).
        const at = await d.startTime(cpid).catch(async (err: unknown) => {
          await d.killGroup(cpid).catch((again: unknown) => d.log(`desktop ${name}: pid ${cpid} could not be ended: ${messageOf(again)}`))
          throw err
        })
        if (at === null) {
          d.log(`desktop ${name}: pid ${child.pid} exited before its start time could be read; recorded with start time 0`)
          return { pid: child.pid, startedAt: 0 }
        }
        launched.set(child.pid, at)
        return { pid: child.pid, startedAt: at }
      },
      kill,
      windows,
      shot: async (o): Promise<DeskShot> => {
        const w = pickWindow(await windows(), o.title)
        if (!w && o.title !== undefined) throw noWindow(o.title)
        const args = ['-display', `:${display}`, '-window', w ? String(w.hwnd) : 'root']
        if (o.maxWidth !== undefined && o.maxWidth > 0) args.push('-resize', `${o.maxWidth}x>`)
        args.push(`${o.format}:-`)
        const bytes = await d.run('import', args, env)
        const size = imageSize(bytes)
        if (size.width === 0) throw new Error(`import returned no ${o.format} image`)
        return { data: bytes.toString('base64'), width: size.width, height: size.height, title: w?.title ?? '' }
      },
      // Xvfb runs no window manager, so nothing is maximized to restore: the window is moved to the
      // display's top left and sized, never past the display (XVFB_SCREEN), and its geometry read back.
      fit: async (o) => {
        const w = pickWindow(await windows(), o.title)
        if (!w) throw o.title !== undefined ? noWindow(o.title) : new Error('no window with a title is showing on this desktop')
        const [sw, sh] = XVFB_SCREEN.split('x').map(Number)
        const id = String(w.hwnd)
        await xdotool(['windowmove', id, '0', '0', 'windowsize', id, String(Math.min(o.width, sw)), String(Math.min(o.height, sh))])
        const g = parseGeometry((await xdotool(['getwindowgeometry', '--shell', id])).toString('utf8'))
        return { width: g.width, height: g.height }
      },
      pointer,
      keys: async (o) => {
        const w = pickWindow(await windows(), o.title)
        if (!w) throw noWindow(o.title)
        const id = String(w.hwnd)
        // R1: focus, then XTEST, in one xdotool run. `--window` would use XSendEvent, whose synthetic
        // events Chromium ignores; this display is the workspace's own, so focusing takes nothing.
        if (o.key !== undefined) {
          const sym = XDOTOOL_KEYS[o.key]
          if (!sym) throw new Error(`unknown key ${o.key}`)
          await xdotool(['windowfocus', id, 'key', '--clearmodifiers', sym])
        }
        if (o.text === undefined) return
        if (specialChars(o.text).length === 0 || !(await typeBound(id, o.text)))
          for (const run of typeRuns(o.text)) await xdotool(['windowfocus', id, ...run])
      },
      close: async () => {
        for (const [p, at] of [...launched]) await kill(p, at).catch((err) => d.log(`desktop ${name}: pid ${p} could not be ended: ${messageOf(err)}`))
        if (st.dead === null) {
          proc.kill('SIGTERM')
          const stop = new AbortController()
          const late = d.sleep(DESK_CLOSE_MS, stop.signal).then(() => 'late' as const)
          const first = await Promise.race([exited, late])
          stop.abort()
          if (first === 'late' && st.dead === null) {
            d.log(`desktop ${name}: Xvfb did not exit within ${DESK_CLOSE_MS / 1000} s of SIGTERM; killing it`)
            proc.kill('SIGKILL')
          }
        }
        taken.delete(display)
        await dropRuntimeDir()
      }
    }
  }

  return { start }
}

export function realLinuxDeskDeps(a: { hostEnv: Record<string, string | undefined>; log(m: string): void }): LinuxDeskDeps {
  const procFs = realLinuxProcFs(execText)
  return {
    hostEnv: a.hostEnv,
    spawn: spawnDetached,
    run: runTool,
    exists: (p) => fs.access(p).then(() => true, () => false),
    makeRuntimeDir: async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-xrt-'))
      // mkdtemp already makes it 0700; said again, since XDG requires exactly that.
      await fs.chmod(dir, 0o700)
      return dir
    },
    removeDir: (p) => fs.rm(p, { recursive: true, force: true }),
    writeFile: (p, text) => fs.writeFile(p, text, 'utf8'),
    startTime: async (pid) => (await linuxStartTimes([pid], procFs)).get(pid) ?? null,
    killGroup: (pid) => killGroup(pid),
    sleep: (ms, signal) =>
      new Promise((r) => {
        if (signal?.aborted) return r()
        const t = setTimeout(r, ms)
        t.unref?.()
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            r()
          },
          { once: true }
        )
      }),
    now: Date.now,
    log: a.log
  }
}
