// One workspace per agent session (agent workspace design, Components 2 and Lifecycle): its desktop
// helper, the launched process tree, the CDP connection, the running script and the last frame. It
// answers `app-js` (src/host/orch.ts), the mirror's Stop and Close, and `workspace-list`, and it writes
// <profile>/orch/workspaces.json so a later Host can end what this one left.
//
// Every dependency that touches a real process arrives in `d`, so the tests drive fakes.
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { SCRIPT_TIMEOUT_MS } from '../../core/agentBrowser/script'
import { evictionPlan } from '../../core/preview/pick/shots'
import { ScriptSlots, type ScriptClock } from '../../core/workspace/script'
import { workspaceHelpers, type AppState, type Cdp, type Desk, type DeskHandle, type HelperDeps, type LaunchSpec, type ResolvedLaunch } from '../../core/workspace/helpers'
import {
  idleExpired,
  leftoverPidsToKill,
  parseWorkspacesFile,
  serializeWorkspacesFile,
  workspaceRefusal,
  type RecordedPid,
  type WorkspaceRecord
} from '../../core/workspace/lifecycle'
import type { LinuxTools } from '../../core/workspace/platform'
import { DEFAULT_APP_SIZE, clampAppSize, deviceSize, frameClip, needsRefit, pageSizedByCdp, sameSize, type AppSize } from '../../core/workspace/size'
import { runScriptInWorker } from './scriptWorker'
import type { WorkspaceEvent, WorkspaceFrame, WorkspaceSummary } from '../../core/host/protocol'
export type { WorkspaceEvent, WorkspaceFrame, WorkspaceSummary }

export const FRAME_EVERY_MS = 1_000
export const FRAME_MAX_WIDTH = 960
export const IDLE_TICK_MS = 30_000
/** How long after a window fit a frame whose page is another size asks for the fit again: the app may
 *  maximize itself after its page answered (an Electron app's `maximize()` on the hidden desktop). */
export const REFIT_AFTER_MS = 3_000
/** Fits of one target size that may follow one another before the manager stops asking: an app that
 *  holds its window at a size of its own (a minimum size larger than the tab) is left at it. */
export const REFIT_TRIES = 3
/** How long a page's size override must hold before it is taken as set, how often it is read
 *  meanwhile, and how many times it is set before the manager gives up (holdPageSize). */
export const OVERRIDE_HOLD_MS = 700
export const OVERRIDE_POLL_MS = 100
export const OVERRIDE_TRIES = 5
/** How long the Host's way out waits for `dispose()` (final review Important 2). A hung helper can
 *  hold a cleanup for tens of seconds, and the server keeps its listener until the Host closes it, so a
 *  replacing Host would wait behind it. Past the cap the Host goes on; the next Host's `sweepLeftovers`
 *  ends what is left (spec, Lifecycle). */
export const DISPOSE_CAP_MS = 10_000
const FRAME_QUALITY = 55

/** Settles when `work` does or when `ms` passes, whichever is first, and calls `onCap` if the cap came
 *  first. `work` keeps running past the cap; the caller gives it its own `.catch` (R3). */
export function disposeWithin(work: Promise<void>, ms: number, onCap: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onCap()
      resolve()
    }, ms)
    timer.unref?.()
  })
  return Promise.race([work, cap]).finally(() => clearTimeout(timer))
}

export interface WorkspaceReply {
  status: number
  body: unknown
}

export interface WorkspaceManagerDeps {
  platform: string
  env: Record<string, string | undefined>
  recordFile: string
  shotsDir: string
  /** The setting (plan ruling P3). Rejects when app-settings.json cannot be read. */
  enabled(): Promise<boolean>
  guide(): string
  /** The session's folder, or null when this Host holds no such session. */
  sessionCwd(sessionId: string): Promise<string | null>
  resolveLaunch(a: { sessionId: string; cwd: string; spec: LaunchSpec }): Promise<ResolvedLaunch>
  startDesk(name: string): Promise<DeskHandle>
  /** Linux only (L1, R8): which of Xvfb, xdotool and import are missing. Asked on every `app js`.
   *  Absent: nothing is checked. */
  linuxTools?(): Promise<LinuxTools>
  connectCdp(port: number, waitMs: number): Promise<Cdp | null>
  freePort(): Promise<number>
  killTree(pid: number): Promise<void>
  startTimes(pids: number[]): Promise<Map<number, number>>
  emit(e: WorkspaceEvent): void
  /** Whether an attached app yields `workspace`, the only reader of frames. */
  hasWatchers(): boolean
  log(m: string): void
  now?(): number
  every?(ms: number, fn: () => void): () => void
  scriptTimeoutMs?: number
  idleMs?: number
  deskPrefix?: string
}

export interface WorkspaceManager {
  run(sessionId: string, script: string): Promise<WorkspaceReply>
  stop(sessionId: string): boolean
  close(sessionId: string): Promise<boolean>
  /** The mirror tab's size in CSS pixels (the app's `workspace-size`): the session's app window is
   *  given that size, now if it is running and at its next launch otherwise. `null` forgets it (the
   *  tab closed), and the next launch takes DEFAULT_APP_SIZE. False when `size` is neither. */
  resize(sessionId: string, size: unknown): boolean
  list(): WorkspaceSummary[]
  sessionEnded(sessionId: string): void
  sweepLeftovers(): Promise<void>
  dispose(): Promise<void>
}

interface Entry {
  sessionId: string
  desk: DeskHandle | null
  deskStarting: Promise<DeskHandle> | null
  state: AppState
  lastActivityAt: number
  helper: string | null
  frame: WorkspaceFrame | null
  capturing: boolean
  dirty: boolean
  stopFrames: (() => void) | null
  /** The script that holds this session's slot now, or null (review minor 3: a stale continuation of
   *  a stopped script must not clean up a desktop a newer script is using). */
  script: AbortController | null
  /** The app was last told this workspace is open (set by every state event). A desktop that fails
   *  to start while this is set is told closed, once (the Task 5 deferred minor: the mirror must not
   *  keep showing a workspace that never came to exist). */
  told: boolean
  /** The running script's launch is waiting for the app's port or page (stage 4, task 2): since when,
   *  and which script's it is. The mirror shows "Starting the app" with the seconds from `since`. */
  launching: { since: number; owner: AbortController } | null
  /** The last window fit: the size it asked for, when, and how many fits of that size ran in a row. */
  fitted: { target: AppSize; at: number; tries: number } | null
  fitting: boolean
  refit: boolean
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createWorkspaceManager(d: WorkspaceManagerDeps): WorkspaceManager {
  const now = d.now ?? Date.now
  const every =
    d.every ??
    ((ms: number, fn: () => void): (() => void) => {
      const timer = setInterval(fn, ms)
      timer.unref?.()
      return () => clearInterval(timer)
    })
  const prefix = d.deskPrefix ?? `astera-ws-${process.pid}`
  const entries = new Map<string, Entry>()
  /** Each session's mirror tab size, kept across launches (and an entry the manager forgot). */
  const sizes = new Map<string, AppSize>()
  const targetOf = (sessionId: string): AppSize => sizes.get(sessionId) ?? DEFAULT_APP_SIZE
  const slots = new ScriptSlots()
  let counter = 0
  let disposed = false
  let writing: Promise<void> = Promise.resolve()
  let sweeping: Promise<void> = Promise.resolve()

  const isOpen = (e: Entry): boolean => e.desk !== null || e.deskStarting !== null

  const safeEmit = (ev: WorkspaceEvent): void => {
    try {
      d.emit(ev)
    } catch (err) {
      d.log(`workspace: an event could not be sent: ${String(err)}`)
    }
  }
  const emitState = (e: Entry, open: boolean): void => {
    e.told = open
    // Only the running script's own launch: a stopped one still waiting on the port is not shown.
    const l = open && e.launching && e.launching.owner === e.script ? e.launching : null
    safeEmit({
      kind: 'state',
      sessionId: e.sessionId,
      open,
      running: slots.isRunning(e.sessionId),
      helper: e.helper,
      ...(l ? { launching: Math.max(0, Math.floor((now() - l.since) / 1_000)) } : {})
    })
  }

  /** Writes what is open now. Serialised, so the last call's picture is the one on disk (R3: logged). */
  const persist = (): void => {
    const records: WorkspaceRecord[] = [...entries.values()]
      .filter((e) => e.desk !== null)
      .map((e) => ({
        sessionId: e.sessionId,
        desktop: e.desk!.name,
        pids: [
          ...(e.state.launched ? [{ pid: e.state.launched.pid, startedAt: e.state.launched.startedAt }] : []),
          // A desktop with no helper process (macOS) records only the app (R7).
          ...(e.desk!.pid !== null ? [{ pid: e.desk!.pid, startedAt: e.desk!.startedAt }] : [])
        ]
      }))
    writing = writing
      .then(async () => {
        if (records.length === 0) await fs.rm(d.recordFile, { force: true })
        else {
          await fs.mkdir(path.dirname(d.recordFile), { recursive: true })
          await fs.writeFile(d.recordFile, serializeWorkspacesFile(records), 'utf8')
        }
      })
      .catch((err) => d.log(`workspace: ${d.recordFile} could not be written: ${String(err)}`))
  }

  const entryOf = (sessionId: string): Entry => {
    let e = entries.get(sessionId)
    if (!e) {
      e = { sessionId, desk: null, deskStarting: null, state: { launched: null, cdp: null }, lastActivityAt: now(), helper: null, frame: null, capturing: false, dirty: false, stopFrames: null, script: null, told: false, launching: null, fitted: null, fitting: false, refit: false }
      entries.set(sessionId, e)
    }
    return e
  }

  /** Ends a recorded process tree only if the live process with that pid started when the record says
   *  (the leftover sweep's rule): a pid alone never decides, because Windows hands numbers out again. */
  const killRecorded = async (sessionId: string, p: RecordedPid): Promise<void> => {
    const [pid] = leftoverPidsToKill([{ sessionId, desktop: '', pids: [p] }], await d.startTimes([p.pid]))
    if (pid === undefined) {
      d.log(`workspace ${sessionId}: pid ${p.pid} is gone or is another process now; left alone`)
      return
    }
    await d.killTree(pid)
  }
  const killRecordedLogged = (sessionId: string, p: RecordedPid): Promise<void> =>
    killRecorded(sessionId, p).catch((err) => d.log(`workspace ${sessionId}: pid ${p.pid} could not be ended: ${String(err)}`))

  /** Emits the close and forgets the entry unless a script still runs in it. The frame timer is the
   *  running script's and ends with it (ruling F6): a script that calls close() and launches again
   *  keeps its frames. */
  const finish = (e: Entry): void => {
    e.helper = null
    e.frame = null
    emitState(e, false)
    if (!slots.isRunning(e.sessionId) && entries.get(e.sessionId) === e) entries.delete(e.sessionId)
  }

  const helperDied = (e: Entry, desk: DeskHandle, why: string): void => {
    if (e.desk !== desk) return
    d.log(`workspace ${e.sessionId}: the desktop helper ended (${why}); cleaning up`)
    const launched = e.state.launched
    e.state.cdp?.close()
    e.state.cdp = null
    e.state.launched = null
    e.desk = null
    slots.stop(e.sessionId)
    if (launched) void killRecordedLogged(e.sessionId, launched)
    persist()
    finish(e)
  }

  const ensureDesk = (e: Entry): Promise<DeskHandle> => {
    // Ruling F1's other half (review critical 1): an entry the manager has already forgotten (its
    // script ended and nothing was open) or a Host that is leaving never gets a desktop, which nothing
    // would record, list or close.
    if (disposed || entries.get(e.sessionId) !== e) return Promise.reject(new Error('launch: stopped (this workspace has ended)'))
    if (e.desk && e.desk.alive()) return Promise.resolve(e.desk)
    if (!e.deskStarting) {
      const name = `${prefix}-${++counter}`
      e.deskStarting = d
        .startDesk(name)
        .then((desk) => {
          e.desk = desk
          desk.onExit((why) => helperDied(e, desk, why))
          persist()
          emitState(e, true)
          return desk
        })
        .finally(() => {
          e.deskStarting = null
        })
      // A desktop that fails to start after the app was told this workspace is open (a Stop while it
      // started: run's finally said `open: true`) is told closed here, whether or not a Close is
      // waiting on it. Attached before any cleanup's wait, so a cleanup that follows finds `told` unset.
      e.deskStarting.catch(() => {
        if (e.told && !isOpen(e) && entries.get(e.sessionId) === e) finish(e)
      })
    }
    return e.deskStarting
  }

  /** Spec, Lifecycle: kill the launched tree, close the desktop, end the helper. `stopScript` is false
   *  for `close()` called by the script itself, which must go on running. */
  const cleanup = async (e: Entry, why: string, stopScript: boolean): Promise<void> => {
    if (stopScript) slots.stop(e.sessionId)
    // A desktop still starting is waited for, and taken only if no other cleanup took it meanwhile (a
    // session that ends while a stopped launch closes its fresh desktop must not close it twice).
    const desk = e.desk ?? (e.deskStarting ? await e.deskStarting.then((k) => (e.desk === k ? k : null), () => null) : null)
    const launched = e.state.launched
    // Review minor 4: a cleanup that finds nothing left (another one took it) tells the app nothing.
    const took = desk !== null || launched !== null
    e.state.cdp?.close()
    e.state.cdp = null
    e.state.launched = null
    e.desk = null
    if (desk) {
      if (launched)
        await desk.kill(launched.pid, launched.startedAt).catch(async (err) => {
          d.log(`workspace ${e.sessionId}: the helper could not end pid ${launched.pid} (${messageOf(err)}); ending it directly`)
          await killRecordedLogged(e.sessionId, launched)
        })
      await desk.close().catch((err) => d.log(`workspace ${e.sessionId}: the desktop did not close: ${String(err)}`))
    } else if (launched) {
      await killRecordedLogged(e.sessionId, launched)
    }
    d.log(`workspace ${e.sessionId}: cleaned up (${why})`)
    persist()
    // A desktop that was starting and failed took nothing here: ensureDesk's rejection handler, which
    // runs before this cleanup's wait resumes, has already told the app it closed (Task 5 deferred minor).
    if (took) finish(e)
    else if (!slots.isRunning(e.sessionId) && !isOpen(e) && entries.get(e.sessionId) === e) entries.delete(e.sessionId)
  }

  /** Lays the page out at `size` through CDP's device metrics and checks that it stays: measured on the
   *  hidden desktop (desktop.e2e.test.ts), an override set as the page settles after launch held for
   *  about 300 ms and was then undone, and set again it held. So it is set, watched for OVERRIDE_HOLD_MS,
   *  and set again while it does not hold, OVERRIDE_TRIES times at most. Answers what it did, for the log. */
  const holdPageSize = async (cdp: Cdp, size: AppSize): Promise<string> => {
    const viewport = async (): Promise<AppSize | null> => {
      const v = await cdp
        .send('Runtime.evaluate', { expression: '[window.innerWidth, window.innerHeight]', returnByValue: true })
        .then((r) => (r.result as { value?: unknown } | undefined)?.value, () => undefined)
      return Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number' ? { width: v[0], height: v[1] } : null
    }
    let seen: AppSize | null = null
    for (let i = 1; i <= OVERRIDE_TRIES; i++) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false })
      let held = true
      for (let waited = 0; waited < OVERRIDE_HOLD_MS && !disposed; waited += OVERRIDE_POLL_MS) {
        seen = await viewport()
        // A page that does not say its size (no answer) is taken at the override's word.
        if (seen === null) return 'the page lays out at that size'
        if (!sameSize(seen, size, 0)) {
          held = false
          break
        }
        await new Promise((r) => setTimeout(r, OVERRIDE_POLL_MS))
      }
      if (held) return i === 1 ? 'the page lays out at that size' : `the page lays out at that size (set ${i} times)`
    }
    return `the page did not keep that size (it is ${seen ? `${seen.width}x${seen.height}` : 'unknown'})`
  }

  /** Gives the app the session's target size (the mirror tab's, or DEFAULT_APP_SIZE): its window
   *  where the desk can size it, in the page's device pixels, and its page through CDP's device metrics
   *  where the window's size does not reliably reach the page (pageSizedByCdp, size.ts says what was
   *  measured). One at a time per entry; a request during one runs once after it. Never rejects (R3). */
  const fitWindow = async (e: Entry, why: string): Promise<void> => {
    const desk = e.desk
    const cdp = e.state.cdp
    const byCdp = cdp !== null && pageSizedByCdp(d.platform)
    if (disposed || !e.state.launched || (!desk?.fit && !byCdp)) return
    if (e.fitting) {
      e.refit = true
      return
    }
    e.fitting = true
    const target = targetOf(e.sessionId)
    const done: string[] = []
    try {
      const tries = e.fitted && sameSize(e.fitted.target, target, 0) ? e.fitted.tries + 1 : 1
      e.fitted = { target, at: now(), tries }
      if (desk?.fit && !byCdp) {
        const dpr = cdp
          ? await cdp.send('Runtime.evaluate', { expression: 'window.devicePixelRatio', returnByValue: true }).then(
              (r) => (r.result as { value?: unknown } | undefined)?.value,
              () => 1
            )
          : 1
        // Best effort where the page is sized through CDP anyway: a window that cannot be found yet (a
        // launch whose port opened before its window) leaves the page to the metrics below.
        const got = await desk.fit(deviceSize(target, dpr)).then(
          (g) => `the window's client area is ${g.width}x${g.height}`,
          (err: unknown) => `the window could not be sized (${messageOf(err)})`
        )
        done.push(got)
      }
      if (cdp && byCdp) done.push(await holdPageSize(cdp, target))
      d.log(`workspace ${e.sessionId}: the app was given ${target.width}x${target.height} CSS px (${why}): ${done.join('; ')}`)
    } catch (err) {
      d.log(`workspace ${e.sessionId}: the app could not be sized (${why}): ${messageOf(err)}`)
    } finally {
      e.fitting = false
    }
    if (e.refit) {
      e.refit = false
      return fitWindow(e, why)
    }
    void captureFrame(e).catch(() => undefined)
  }

  /** A page whose viewport is not the size its window was given asks for the fit again, REFIT_AFTER_MS
   *  after the last one and at most REFIT_TRIES times for one size. */
  const checkFit = (e: Entry, viewport: AppSize): void => {
    if (!e.state.launched || e.fitting || (!e.desk?.fit && !pageSizedByCdp(d.platform))) return
    const target = targetOf(e.sessionId)
    if (!needsRefit(viewport, target)) return
    // No fit yet: the launch is still waiting for the page, and fits the window once it settles.
    const f = e.fitted
    if (!f) return
    if (sameSize(f.target, target, 0) && (f.tries >= REFIT_TRIES || now() - f.at < REFIT_AFTER_MS)) return
    void fitWindow(e, `the page is ${viewport.width}x${viewport.height}`)
  }

  const frameOf = async (e: Entry): Promise<WorkspaceFrame | null> => {
    const cdp = e.state.cdp
    if (cdp) {
      const fc = frameClip(await cdp.send('Page.getLayoutMetrics'), FRAME_MAX_WIDTH)
      if (fc) checkFit(e, fc.css)
      const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: FRAME_QUALITY, ...(fc ? { clip: fc.clip } : {}) })
      if (typeof r.data !== 'string' || r.data === '') return null
      return { jpeg: r.data, width: fc?.frame.width ?? 0, height: fc?.frame.height ?? 0, at: now() }
    }
    if (e.desk && e.state.launched) {
      const s = await e.desk.shot({ format: 'jpeg', maxWidth: FRAME_MAX_WIDTH })
      return { jpeg: s.data, width: s.width, height: s.height, at: now() }
    }
    return null
  }

  /** Never rejects (R3). One capture at a time per entry; a request that lands during one is folded
   *  into a single capture after it (plan ruling P12). */
  const captureFrame = async (e: Entry): Promise<void> => {
    if (disposed || !isOpen(e) || !d.hasWatchers()) return
    if (e.capturing) {
      e.dirty = true
      return
    }
    e.capturing = true
    try {
      const frame = await frameOf(e)
      if (frame && entries.get(e.sessionId) === e && isOpen(e)) {
        e.frame = frame
        safeEmit({ kind: 'frame', sessionId: e.sessionId, frame })
      }
    } catch {
      /* a frame that fails is skipped; the next tick tries again */
    } finally {
      e.capturing = false
      if (e.dirty) {
        e.dirty = false
        void captureFrame(e).catch(() => undefined)
      }
    }
  }

  const evict = async (): Promise<void> => {
    try {
      const names = await fs.readdir(d.shotsDir)
      const files = await Promise.all(
        names
          .filter((n) => n.endsWith('.png'))
          .map(async (n) => {
            const p = path.join(d.shotsDir, n)
            return { path: p, mtimeMs: (await fs.stat(p)).mtimeMs }
          })
      )
      await Promise.all(evictionPlan(files, now()).map((p) => fs.unlink(p).catch(() => undefined)))
    } catch {
      /* the next capture tries again */
    }
  }

  const saveCapture = async (data: string, ext: 'png'): Promise<string> => {
    await fs.mkdir(d.shotsDir, { recursive: true })
    const file = path.join(d.shotsDir, `app-${randomUUID()}.${ext}`)
    await fs.writeFile(file, Buffer.from(data, 'base64'))
    void evict()
    return file
  }

  /** The desktop as a script's helpers see it. A launch that resolves after its desktop was cleaned up
   *  (Close, the session ending, the Host leaving, while the app was starting) started an app nobody
   *  holds: it is ended at once, by pid and start time, and the launch fails as stopped (review
   *  important 2). */
  const guardedDesk = (e: Entry, desk: DeskHandle): Desk => ({
    name: desk.name,
    launch: async (a) => {
      const started = await desk.launch(a)
      if (e.desk !== desk || entries.get(e.sessionId) !== e) {
        d.log(`workspace ${e.sessionId}: the desktop closed while pid ${started.pid} was starting; ending it`)
        await killRecordedLogged(e.sessionId, started)
        throw new Error('launch: stopped (the workspace closed while the app was starting; the app was ended)')
      }
      return started
    },
    kill: (pid, startedAt) => desk.kill(pid, startedAt),
    windows: () => desk.windows(),
    shot: (a) => desk.shot(a),
    keys: (a) => desk.keys(a),
    ...(desk.fit ? { fit: desk.fit.bind(desk) } : {}),
    ...(desk.pointer ? { pointer: desk.pointer } : {}),
    close: () => desk.close()
  })

  /** A launch wait of the script `stop` belongs to: the runner's clock holds the deadline, and the
   *  mirror hears that the app is starting, then that it is no longer (FRAME_EVERY_MS re-tells the
   *  seconds). Two at once (a launch the script did not await) are shown as one, from the first. */
  const launchWaits = (e: Entry, clock: ScriptClock, stop: AbortController): HelperDeps['launchWait'] => {
    let waits = 0
    return () => {
      const w = clock.launchWait()
      waits += 1
      // A stopped script's launch still waiting on the port never takes the place of a newer one's.
      if (waits === 1 && e.script === stop) e.launching = { since: now(), owner: stop }
      if (isOpen(e)) emitState(e, true)
      let ended = false
      return {
        leftMs: w.leftMs,
        end: () => {
          if (ended) return
          ended = true
          w.end()
          waits -= 1
          if (waits > 0 || e.launching?.owner !== stop) return
          e.launching = null
          if (isOpen(e)) emitState(e, true)
        }
      }
    }
  }

  const helperDeps = (e: Entry, cwd: string, clock: ScriptClock, stop: AbortController): HelperDeps => ({
    state: e.state,
    // Ruling F1: a desktop that finishes starting after this script was stopped, with nothing launched
    // on it, is closed at once, unless a newer script holds the session and is using it (review minor
    // 3); `launch` then refuses to start the app (it asks `stopped()` again).
    desk: async () => {
      const desk = await ensureDesk(e)
      const newer = e.script !== null && e.script !== stop
      if ((stop.signal.aborted || disposed) && !newer && !e.state.launched && e.desk === desk) await cleanup(e, 'stopped before the launch', false)
      return guardedDesk(e, desk)
    },
    stopped: () => stop.signal.aborted || disposed,
    deskIfOpen: () => e.desk,
    resolveLaunch: (spec) => d.resolveLaunch({ sessionId: e.sessionId, cwd, spec }),
    freePort: () => d.freePort(),
    connectCdp: (port, waitMs) => d.connectCdp(port, waitMs),
    saveCapture,
    recordLaunch: () => persist(),
    started: () => {
      e.fitted = null
      return fitWindow(e, 'launched')
    },
    changed: () => {
      void captureFrame(e).catch(() => undefined)
    },
    cleanup: () => cleanup(e, 'close()', false),
    launchWait: launchWaits(e, clock, stop),
    now,
    guide: d.guide(),
    platform: d.platform
  })

  const stopIdle = every(IDLE_TICK_MS, () => {
    for (const e of [...entries.values()]) {
      if (!isOpen(e)) continue
      if (!idleExpired({ lastActivityAt: e.lastActivityAt, now: now(), running: slots.isRunning(e.sessionId), idleMs: d.idleMs })) continue
      void cleanup(e, 'no script for 10 minutes', true).catch((err) => d.log(`workspace ${e.sessionId}: the idle cleanup failed: ${String(err)}`))
    }
  })

  const doSweep = async (): Promise<void> => {
    try {
      const text = await fs.readFile(d.recordFile, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null
        throw err
      })
      if (text === null) return
      const records = parseWorkspacesFile(text)
      const pids = [...new Set(records.flatMap((r) => r.pids.map((p) => p.pid)))]
      const kill = pids.length > 0 ? leftoverPidsToKill(records, await d.startTimes(pids)) : []
      for (const pid of kill) await d.killTree(pid).catch((err) => d.log(`workspace leftovers: pid ${pid} could not be ended: ${String(err)}`))
      d.log(`workspace leftovers: ${records.length} recorded, ${kill.length} process(es) still running and ended`)
      await fs.rm(d.recordFile, { force: true })
    } catch (err) {
      d.log(`workspace leftovers: the sweep failed: ${String(err)}`)
    }
  }

  return {
    run: async (sessionId, script) => {
      if (disposed) return { status: 409, body: { error: 'the Host is leaving' } }
      // What no setting can change comes first (the platform, SSH), then the setting, then the Linux
      // tools: a Host with the workspace off says so before naming tools to install, but never tells the
      // person to turn on what could not run here anyway.
      const fixed = workspaceRefusal({ platform: d.platform, env: d.env, linuxTools: null })
      if (fixed) return { status: 409, body: { error: fixed } }
      let on: boolean
      try {
        on = await d.enabled()
      } catch (err) {
        return { status: 409, body: { error: messageOf(err), repair: 'app-settings.json' } }
      }
      if (!on) return { status: 409, body: { error: 'agent app workspace is off' } }
      let linuxTools: LinuxTools | null = null
      const probe = d.linuxTools
      if (d.platform === 'linux' && probe)
        // Through a resolved promise, so a probe that throws at once is caught like one that rejects.
        linuxTools = await Promise.resolve()
          .then(() => probe())
          .catch((err: unknown) => {
            d.log(`workspace: the Linux tool check failed (${messageOf(err)}); going on without it`)
            return null
          })
      const refusal = workspaceRefusal({ platform: d.platform, env: d.env, linuxTools })
      if (refusal) return { status: 409, body: { error: refusal } }
      const cwd = await d.sessionCwd(sessionId).catch(() => null)
      if (cwd === null) return { status: 404, body: { error: 'no such session' } }
      await sweeping
      const ac = slots.begin(sessionId)
      if (!ac) return { status: 409, body: { error: 'a script is already running' } }
      const e = entryOf(sessionId)
      e.script = ac
      const startedAt = now()
      const timeoutMs = d.scriptTimeoutMs ?? SCRIPT_TIMEOUT_MS
      e.lastActivityAt = startedAt
      if (isOpen(e)) emitState(e, true)
      e.stopFrames = every(FRAME_EVERY_MS, () => {
        // While the app is starting, the mirror's seconds move on with each frame tick.
        if (e.launching?.owner === ac && isOpen(e)) emitState(e, true)
        void captureFrame(e).catch(() => undefined)
      })
      try {
        // In a worker of its own, so a busy loop cannot freeze the Host (scriptWorker.ts).
        const result = await runScriptInWorker({
          script,
          guide: d.guide(),
          stop: ac.signal,
          timeoutMs,
          onHelper: (name) => {
            e.helper = name
            if (isOpen(e)) emitState(e, true)
          },
          helpers: (ctx, clock) => workspaceHelpers(helperDeps(e, cwd, clock, ac), ctx)
        })
        return { status: 200, body: result }
      } finally {
        // The runner aborts only its own controller; this one is what `stopped()` reads, so a launch
        // the script left behind (not awaited, or cut off by the timeout) stops too (review critical 1).
        ac.abort()
        slots.end(sessionId, ac)
        if (e.script === ac) e.script = null
        if (e.launching?.owner === ac) e.launching = null
        e.stopFrames?.()
        e.stopFrames = null
        e.helper = null
        e.lastActivityAt = now()
        if (isOpen(e)) {
          emitState(e, true)
          void captureFrame(e).catch(() => undefined)
        } else if (entries.get(sessionId) === e) entries.delete(sessionId)
      }
    },
    stop: (sessionId) => slots.stop(sessionId),
    resize: (sessionId, size) => {
      if (size === null) {
        sizes.delete(sessionId)
        return true
      }
      const next = clampAppSize(size)
      if (next === null) return false
      const was = sizes.get(sessionId) ?? null
      sizes.set(sessionId, next)
      const e = entries.get(sessionId)
      if (e && isOpen(e) && !sameSize(was, next, 0)) void fitWindow(e, 'the mirror tab was resized')
      return true
    },
    close: async (sessionId) => {
      const e = entries.get(sessionId)
      if (!e || !isOpen(e)) return false
      await cleanup(e, 'Close in the app', true)
      return true
    },
    list: () =>
      [...entries.values()].filter(isOpen).map((e) => ({ sessionId: e.sessionId, running: slots.isRunning(e.sessionId), helper: e.helper, frame: e.frame })),
    sessionEnded: (sessionId) => {
      sizes.delete(sessionId)
      const e = entries.get(sessionId)
      if (!e) return
      slots.stop(sessionId)
      if (isOpen(e)) void cleanup(e, 'the session ended', true).catch((err) => d.log(`workspace ${sessionId}: the cleanup failed: ${String(err)}`))
    },
    sweepLeftovers: () => {
      sweeping = doSweep()
      return sweeping
    },
    dispose: async () => {
      disposed = true
      stopIdle()
      slots.stopAll()
      await Promise.all([...entries.values()].filter(isOpen).map((e) => cleanup(e, 'the Host is leaving', true).catch((err) => d.log(`workspace ${e.sessionId}: ${String(err)}`))))
      await writing
    }
  }
}
