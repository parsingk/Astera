// Runs the enabled plugins (plugin runtime design P2, P9, P11-P13; spec §13-14): one process per plugin, the Host's own
// executable as Node on the launcher bundled beside the Host, JSON-RPC on its stdio. The plugin's calls are answered by
// the orch as the plugin, with the permissions its record grants; its stderr is its log. A crash restarts it after a
// backoff, and the third crash without a steady run between marks it failed until a person starts it again. Plugins do
// not keep the Host alive: they run while it runs.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import type { Duplex, Readable } from 'node:stream'
import path from 'node:path'
import { hostWorkerBaseEnv } from '../../core/host/spawn'
import { killProcessTree } from '../../core/run/kill'
import { REDACT_MIN, redactSecrets, redactTerms, redactionTerms } from '../../core/remote/redact'
import type { OrchCall } from '../../core/host/orchProtocol'
import { RPC_CLOSED, RPC_INTERNAL_ERROR, RPC_INVALID_PARAMS, RPC_METHOD_NOT_FOUND, RPC_NOT_READY, RpcError, createRpcPeer, type RpcPeer } from '../../core/plugins/rpc'
import { capabilityPermissionProblem, type PluginCapability } from '../../core/plugins/manifest'
import { PluginSecretRefused, pluginCursor, pluginSecrets, type CursorStore } from './pluginData'
import { DeliveryInterrupted, createDeliverer, type Deliverer, type DeliverySource, type DeliveryTimings } from './deliverer'
import { NOTIFICATION_MAX_AGE_MS, type PluginNotification } from '../../core/plugins/notifications'
import type { AsteraEvent } from '../../core/publicContract'
import { openHostLog, type HostLog } from '../log'
import { releaseLogWriter } from '../../core/log/logWriter'
import { pluginsRoot } from './registry'

export interface PluginTimings {
  /** How long `initialize` may take: loading the entry and `activate`. */
  startMs: number
  /** How long a stopping plugin has after `shutdown`, and again after the kill. */
  stopGraceMs: number
  /** The waits before the first, second and later restarts. */
  backoffMs: readonly number[]
  /** A run this long resets the crash count. */
  stableMs: number
  /** The crash, counted from the last steady run, that marks the plugin failed. */
  failAfter: number
}

/** The longest message a plugin may send the Host, in characters (2b final review I2): what a plugin sends is not the
 *  Host's own message, and a line without end must not grow the Host's memory until it falls over. */
export const PLUGIN_MAX_LINE = 32 * 1024 * 1024

export const PLUGIN_TIMINGS: PluginTimings = { startMs: 30_000, stopGraceMs: 5_000, backoffMs: [1000, 2000], stableMs: 30_000, failAfter: 3 }

/** How long a leaving Host waits for its plugins: a stop's grace after `shutdown`, the kill's, and a second more. */
export const PLUGIN_STOP_CAP_MS = PLUGIN_TIMINGS.stopGraceMs * 2 + 1_000

/** What the runtime needs to start a plugin, from its registry record and its installed copy. */
export interface PluginLaunch {
  id: string
  version: string
  /** Its folder name, which names its log too. */
  folder: string
  /** The installed copy, where it runs. */
  dir: string
  /** The entry file, absolute. */
  entry: string
  granted: readonly string[]
  /** The capabilities its manifest names that this Astera serves (plugin Phase 3): `event` gets it the event log. */
  capabilities: readonly PluginCapability[]
  /** Its settings, secret ones included, handed over at `initialize` (spec §24, design P10). */
  settings: Readonly<Record<string, string | number | boolean>>
  /** Values its log must never show: its secret settings and secrets (spec §23). */
  redact: readonly string[]
}

export interface PluginRunStatus {
  status: 'starting' | 'running' | 'stopped' | 'failed'
  reason?: string
  pid?: number
}

export interface PluginRuntime {
  /** Starts the plugin unless it is already starting or running. */
  start(p: PluginLaunch): void
  /** Starts it afresh: a failed plugin's crash count is cleared. */
  restart(p: PluginLaunch): void
  stop(id: string): Promise<void>
  stopAll(): Promise<void>
  status(id: string): PluginRunStatus | undefined
  logFile(folder: string): string
  /** Lets go of a plugin's log, written out first, so a removal can delete it for good (2b final review M2). */
  forget(folder: string): Promise<void>
  /** Asks a running plugin `method` and answers what it returned (plugin Phase 4 J6, J8): rejects with
   *  PluginRequestFailed, 503 at once when the plugin does not run, 504 past `timeoutMs`, 502 with what it threw. */
  request(id: string, method: string, params: unknown, timeoutMs: number): Promise<unknown>
}

/** Why a request to a plugin got no answer, as the status the Host answers its caller with (plugin Phase 4 J8). */
export class PluginRequestFailed extends Error {
  constructor(
    readonly status: 502 | 503 | 504,
    message: string
  ) {
    super(message)
  }
}

/** What a request that failed answers its caller (J8): a channel that ended, or a launcher whose plugin is not started
 *  or is stopping (a race with a stop: 4a final review M8), is a plugin that does not run, 503; anything else is what
 *  the plugin threw, 502, through `hide`, since it can hold a secret like every line of its log. */
export function requestFailure(id: string, e: unknown, hide: (m: string) => string): PluginRequestFailed {
  if (e instanceof PluginRequestFailed) return e
  if (e instanceof RpcError && e.code === RPC_CLOSED) return new PluginRequestFailed(503, `${id} exited while it answered`)
  if (e instanceof RpcError && e.code === RPC_NOT_READY) return new PluginRequestFailed(503, `${id} is not ready: ${e.message}`)
  return new PluginRequestFailed(502, hide(e instanceof Error ? e.message : String(e)))
}

/** A plugin's log (design P13): `<profile>/plugins/logs/<folder>.log`, rotated to `.1` past 2 MiB. */
export const pluginLogFile = (profileDir: string, folder: string): string => path.join(pluginsRoot(profileDir), 'logs', `${folder}.log`)

/** A line of stderr longer than this is written in pieces, so a plugin printing without end cannot grow a buffer. */
const STDERR_LINE_MAX = 64 * 1024
/** How many lines of a plugin's output its log takes a second (5e, from the performance review): every line is redacted
 *  on the Host's thread, which also serves every terminal, so a plugin printing without end must not have them all. */
export const LOG_LINES_PER_SECOND = 1_000
/** And how many characters (5e final review M4): long lines are what cost the redaction and the log's rotation. */
export const LOG_CHARS_PER_SECOND = 1_048_576
/** How many of the lines dropped in a second are written when the process ends then: a crash's stack (I2). */
const DROPPED_TAIL = 20

interface Slot {
  launch: PluginLaunch
  state: 'starting' | 'running' | 'waiting' | 'stopped' | 'failed'
  /** Whether the plugin should be running: false once a stop was asked for. */
  wanted: boolean
  proc?: ChildProcess
  peer?: RpcPeer
  runningSince?: number
  /** What went wrong with the current or the last run, for the reason a person reads. */
  problem?: string
  failures: number
  reason?: string
  timers: Set<ReturnType<typeof setTimeout>>
  /** Each secret it read or set since it was started, by name: kept through a restart after a crash (2c final review
   *  I2), and one value a name, so a plugin that keeps a cursor there does not grow every log line's cost (M11). */
  learned: Map<string, string>
  /** What its log hides, worked out from `launch.redact` and `learned` when either changes. */
  terms?: string[]
  exited?: Promise<void>
  stopping?: Promise<void>
  /** An event or notification plugin's deliverer (plugin Phase 3): from its start until a stop, through its crashes
   *  and restarts. */
  deliverer?: Deliverer
  /** The last deliverer's stop, until its cursor is written: a second stop and a start wait for it (final review M4). */
  delivering?: Promise<void>
  /** The notifications skipped as older than NOTIFICATION_MAX_AGE_MS since the last line that counted them (N9). */
  stale: string[]
  /** Counts the deliveries begun, so one the deliverer gave up at its time limit does not go on to send beside the
   *  next try (3c final review M2). */
  attempts: number
  /** The notification whose send was last begun: one that grows old while it fails is tried until it is sent or
   *  given up, not counted stale (3c final review M4). */
  tried?: string
}

/** The handler each capability is served through (plugin Phase 3 N5): a plugin whose entry lacks it does not start. */
const HANDLER_OF: Partial<Record<PluginCapability, readonly string[]>> = {
  event: ['onEvent'],
  notification: ['send'],
  'job-source': ['listItems', 'getItem', 'buildJobContext'],
  'completion-check': ['runCheck']
}

/** The capabilities served from the event log by a deliverer (plugin Phase 3 N1). */
const delivered = (p: PluginLaunch): boolean => p.capabilities.includes('event') || p.capabilities.includes('notification')

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// REDACT_MIN and redactionTerms moved to core/remote/redact.ts, shared with the extension secrets (Agent Control
// Plane release 1 design §4.9); still exported from here for the plugin manager and the docs test.
export { REDACT_MIN, redactionTerms }

/** Kills the plugin and everything it started: taskkill /T on Windows; elsewhere the process group the plugin was
 *  started as the leader of. */
function killTree(proc: ChildProcess): void {
  if (process.platform === 'win32') return killProcessTree(proc)
  try {
    if (proc.pid !== undefined) process.kill(-proc.pid, 'SIGKILL')
  } catch {
    try {
      proc.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

/** How long what is left of a plugin's process group has after SIGTERM before SIGKILL. */
const GROUP_KILL_GRACE_MS = 2_000

/** Ends what is left of a plugin's process group once the plugin has exited (2b final review I4): a child it started
 *  and did not end would outlive it, and one more set would be left at every restart or update. Elsewhere than Windows
 *  only; there the launcher's job object ends its children with it. A group with nothing left in it is no error. */
function endGroup(pid: number | undefined): void {
  if (process.platform === 'win32' || pid === undefined) return
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    return
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }, GROUP_KILL_GRACE_MS).unref()
}

/** The environment a plugin starts with: the Host's own, without what is the Host's alone (HOST_ONLY_ENV) and without
 *  any ASTERA_ variable (a plugin is no agent session and reaches the Host on its own channel), plus the switch that
 *  runs the Host's executable as Node, which the launcher removes before the plugin loads. */
export function pluginEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(hostWorkerBaseEnv(env))) if (!/^ASTERA_/i.test(k)) out[k] = v
  out.ELECTRON_RUN_AS_NODE = '1'
  return out
}

export function createPluginRuntime(d: {
  profileDir: string
  /** The Host's own executable (`process.execPath`). */
  exec: string
  /** out/main/plugin-host.js, beside the Host's own bundle. */
  launcher: string
  env: NodeJS.ProcessEnv
  host: () => { version: string; pid: number; startedAt: string; features: string[] }
  orch: Pick<OrchCall, 'call'>
  /** The Host's own log. */
  log: (m: string) => void
  spawn?: typeof nodeSpawn
  timings?: Partial<PluginTimings>
  now?: () => number
  /** For tests: the ceiling on a plugin's message (`PLUGIN_MAX_LINE`). */
  maxLine?: number
  /** The Host's public event log, which event plugins are handed (plugin Phase 3 N1). Absent: none is delivered to. */
  events?: DeliverySource
  /** For tests: the deliverer's waits (DELIVERY_TIMINGS). */
  delivery?: Partial<DeliveryTimings>
  /** For tests: where an event plugin's cursor is kept (pluginCursor). */
  cursors?: (folder: string) => CursorStore
  /** The notification for an event, worded for a person (plugin Phase 3 N10, notifications.ts), or null when the event
   *  is not one. Absent: a notification plugin is sent nothing. */
  notify?: (event: AsteraEvent) => PluginNotification | null | Promise<PluginNotification | null>
}): PluginRuntime {
  const t: PluginTimings = { ...PLUGIN_TIMINGS, ...d.timings }
  const spawn = d.spawn ?? nodeSpawn
  const now = d.now ?? Date.now
  const slots = new Map<string, Slot>()
  const logs = new Map<string, HostLog>()
  const logFile = (folder: string): string => pluginLogFile(d.profileDir, folder)
  const logOf = (folder: string): HostLog => {
    let l = logs.get(folder)
    if (!l) logs.set(folder, (l = openHostLog({ path: logFile(folder) })))
    return l
  }
  // What the Host writes about a plugin carries the plugin's own words (an error message, a stray line), which may hold
  // a secret: redacted like the plugin's own lines (2b final review M1).
  /** A line for a plugin's log, with every secret of that plugin and every secret-shaped value taken out (P13). */
  const hide = (s: Slot, line: string): string => {
    return redactTerms(redactSecrets(line), (s.terms ??= redactionTerms([...s.launch.redact, ...s.learned.values()])))
  }
  const learn = (s: Slot, name: unknown, value: unknown): void => {
    if (typeof name !== 'string' || typeof value !== 'string' || s.learned.get(name.toLowerCase()) === value) return
    s.learned.set(name.toLowerCase(), value)
    s.terms = undefined
  }
  const say = (s: Slot, m: string): void => logOf(s.launch.folder).write(hide(s, `[host] ${m}`))
  const later = (s: Slot, ms: number, f: () => void): void => {
    const timer = setTimeout(() => {
      s.timers.delete(timer)
      f()
    }, ms)
    s.timers.add(timer)
  }
  const clearTimers = (s: Slot): void => {
    for (const timer of s.timers) clearTimeout(timer)
    s.timers.clear()
  }

  /** A plugin's call, answered by the orch as that plugin with what its record grants (design P12). */
  const forward = async (s: Slot, granted: ReadonlySet<string>, params: unknown): Promise<unknown> => {
    const p = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : null
    const args = p?.args ?? {}
    if (!p || typeof p.cmd !== 'string' || typeof args !== 'object' || args === null || Array.isArray(args) || (p.request !== undefined && typeof p.request !== 'string'))
      throw new RpcError(RPC_INVALID_PARAMS, 'call needs { cmd, args?, request? }')
    try {
      const r = await d.orch.call({
        cmd: p.cmd,
        args: args as Record<string, unknown>,
        sessionId: '',
        from: { role: 'plugin', plugin: { id: s.launch.id, granted }, toOthers: () => {} },
        ...(typeof p.request === 'string' ? { request: p.request } : {})
      })
      return { status: r.status, body: r.body, ...(r.replayed === true ? { replayed: true } : {}), ...(r.observed === true ? { observed: true } : {}) }
    } catch (e) {
      return { status: 500, body: { error: e instanceof Error ? e.message : String(e) } }
    }
  }

  /** A plugin's request about its own secrets (spec §23): answered from the store kept for that plugin alone, so no
   *  name it passes reaches another's. A value it reads or sets joins what its log never shows (2c final review C1). */
  async function secretRequest(s: Slot, method: string, params: unknown): Promise<unknown> {
    const q = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
    const store = pluginSecrets(d.profileDir, s.launch.folder).secret
    try {
      if (method === 'secrets.get') {
        const value = await store.get(q.name as string)
        learn(s, q.name, value)
        return { value: value ?? null }
      }
      if (method === 'secrets.set') {
        await store.set(q.name as string, q.value as string)
        learn(s, q.name, q.value)
        return {}
      }
      await store.delete(q.name as string)
      return {}
    } catch (e) {
      if (e instanceof PluginSecretRefused) throw new RpcError(RPC_INVALID_PARAMS, e.message)
      throw new RpcError(RPC_INTERNAL_ERROR, `the plugin's secrets could not be used: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Counts the stale notifications skipped since the last such line, in one line (N9). */
  const sayStale = (s: Slot): void => {
    const n = s.stale.length
    if (n === 0) return
    const ids = n === 1 ? s.stale[0] : `${s.stale[0]} to ${s.stale[n - 1]}`
    s.stale = []
    say(s, `skipped ${n} notification${n === 1 ? '' : 's'} older than an hour (${ids})`)
  }

  /** The deliverer of an event or notification plugin (plugin Phase 3 N1, N6-N10): it hands the plugin the event log
   *  from its cursor while the plugin runs, onEvent first and then send, and its lines go to the plugin's log. */
  const makeDeliverer = (s: Slot, events: DeliverySource): Deliverer =>
    createDeliverer({
      source: events,
      cursor: d.cursors ? d.cursors(s.launch.folder) : pluginCursor(d.profileDir, s.launch.folder),
      running: () => s.state === 'running' && s.peer !== undefined,
      deliver: async (item, signal) => {
        const peer = s.peer
        if (!peer || s.state !== 'running') throw new DeliveryInterrupted('the plugin is not running')
        const attempt = ++s.attempts
        const ask = async (method: string, params: unknown): Promise<void> => {
          try {
            await peer.request(method, params, { signal })
          } catch (e) {
            // The process ended under the delivery: it is started again, and the event goes again once it runs
            if (e instanceof RpcError && e.code === RPC_CLOSED) throw new DeliveryInterrupted(e.message)
            throw e
          }
        }
        const caps = s.launch.capabilities
        if (caps.includes('event')) await ask('events.deliver', { event: item })
        // A newer try began while this one waited past the time limit: it sends, not this one
        if (!caps.includes('notification') || attempt !== s.attempts) return
        // N9: a notification plugin is told of a gap in its log only, and is sent no stale notification
        if (item.type === 'gap') return say(s, 'events were lost before the next one (older than the log keeps): no notification was sent for them')
        let n: PluginNotification | null
        try {
          n = (await d.notify?.(item)) ?? null
        } catch (e) {
          // The Host's wording failed: trying again changes nothing, and the plugin is not at fault (3c final review I1)
          say(s, `could not word ${item.type} ${item.id} (${e instanceof Error ? e.message : String(e)}): it is not sent`)
          return
        }
        if (n === null || attempt !== s.attempts) return
        if (n.id !== s.tried && Date.now() - Date.parse(n.occurredAt) > NOTIFICATION_MAX_AGE_MS) {
          s.stale.push(n.id)
          return
        }
        sayStale(s)
        s.tried = n.id
        await ask('notifications.send', { notification: n })
      },
      log: (m) => say(s, m),
      idle: () => sayStale(s),
      // Not the runtime's clock: the deliverer's own goes only forward, which the give-up hour is counted on (3b M1)
      ...(d.delivery ? { timings: d.delivery } : {})
    })

  function launch(s: Slot): void {
    const p = s.launch
    s.state = 'starting'
    s.problem = undefined
    s.runningSince = undefined
    // Plugin Phase 3 N4: an event or notification plugin without the grant its events need is not started (the install
    // refuses it too)
    const ungranted = capabilityPermissionProblem(p.capabilities, p.granted)
    if (ungranted !== null) {
      s.problem = ungranted
      say(s, ungranted)
      return crashed(s, ungranted)
    }
    let proc: ChildProcess
    try {
      proc = spawn(d.exec, [d.launcher], {
        cwd: p.dir,
        env: pluginEnv(d.env),
        // The channel is the fourth pipe (2b final review I1): a child that inherits the plugin's stdio gets 0 to 2 only,
        // so nothing printed reaches it. No stdin: a child that reads it cannot take the Host's messages either.
        // Overlapped (plugin Phase 3): a 'pipe' gives the plugin a synchronous handle on Windows, where the read always
        // pending holds every write until the Host writes again, so a call or an answer the plugin sent from a timer
        // waited for the Host's next message. Elsewhere it is a plain pipe.
        stdio: ['ignore', 'pipe', 'pipe', 'overlapped'],
        windowsHide: true,
        // Elsewhere than Windows, the leader of a process group, so a stop can end what the plugin started too.
        detached: process.platform !== 'win32'
      })
    } catch (e) {
      s.problem = `it could not be started: ${e instanceof Error ? e.message : String(e)}`
      return crashed(s, s.problem)
    }
    s.proc = proc
    let resolveExit: () => void = () => {}
    s.exited = new Promise((r) => (resolveExit = r))
    say(s, `started pid ${proc.pid ?? '?'}`)
    const granted: ReadonlySet<string> = new Set(p.granted)
    const channel = proc.stdio[3] as Duplex | null | undefined
    const peer = createRpcPeer({
      send: (line) => {
        if (channel && !channel.destroyed && !channel.writableEnded) channel.write(line)
      },
      onBadMessage: (m) => say(s, m),
      maxLine: d.maxLine ?? PLUGIN_MAX_LINE,
      onOverflow: () => {
        if (s.proc !== proc) return
        s.problem = `it sent the Host a message longer than ${d.maxLine ?? PLUGIN_MAX_LINE} characters`
        say(s, s.problem)
        killTree(proc)
      },
      onRequest: async (method, params) => {
        if (method === 'call') return forward(s, granted, params)
        if (method === 'secrets.get' || method === 'secrets.set' || method === 'secrets.delete') return secretRequest(s, method, params)
        throw new RpcError(RPC_METHOD_NOT_FOUND, `no method ${method}`)
      }
    })
    s.peer = peer
    channel?.setEncoding('utf8')
    channel?.on('data', (c: string) => {
      // Nothing a plugin sends may throw into the Host's event loop (spec §13).
      try {
        peer.feed(c)
      } catch (e) {
        say(s, `the channel could not be read: ${e instanceof Error ? e.message : String(e)}`)
        killTree(proc)
      }
    })
    // A budget a second (LOG_LINES_PER_SECOND lines, LOG_CHARS_PER_SECOND characters): past it a line is counted, not
    // redacted or written. The count is said once, when its second is over (a timer at its end, or the next second's
    // first line), or when the process ends; then the last lines dropped in that second are written too, so a crash at
    // the end of a flood keeps its stack (5e final review I1, I2). A steady clock: a clock set back holds no window open.
    // A timer can fire before its second is over by that clock (whole milliseconds, a loaded machine's drift), so it
    // waits out the rest: a count said early was followed by another count of the same second.
    let windowStart = -Infinity
    let lines = 0
    let chars = 0
    let dropped = 0
    let tail: string[] = []
    const sayDropped = (atEnd: boolean): void => {
      if (dropped > 0) {
        const n = dropped.toLocaleString('en-US')
        say(s, `dropped ${n} line${dropped === 1 ? '' : 's'} of its output: more than ${LOG_LINES_PER_SECOND.toLocaleString('en-US')} lines or ${LOG_CHARS_PER_SECOND.toLocaleString('en-US')} characters a second`)
        if (atEnd && tail.length > 0) {
          say(s, `the last ${tail.length} of them, before it ended:`)
          for (const t of tail) logOf(p.folder).write(hide(s, t))
        }
      }
      dropped = 0
      tail = []
    }
    const sayAtEndOf = (second: number): void => {
      later(s, Math.max(0, second + 1_000 - performance.now()), () => {
        if (windowStart !== second) return
        if (performance.now() - second < 1_000) sayAtEndOf(second)
        else sayDropped(false)
      })
    }
    const line = (l: string): void => {
      const text = l.replace(/\r$/, '')
      if (text === '') return
      const now = performance.now()
      if (now - windowStart >= 1_000) {
        sayDropped(false)
        windowStart = now
        lines = 0
        chars = 0
      }
      if (lines >= LOG_LINES_PER_SECOND || chars + text.length > LOG_CHARS_PER_SECOND) {
        if (dropped++ === 0) sayAtEndOf(windowStart)
        tail.push(text)
        if (tail.length > DROPPED_TAIL) tail.shift()
        return
      }
      lines += 1
      chars += text.length
      logOf(p.folder).write(hide(s, text))
    }
    // stdout and stderr are both the plugin's log, each read in lines of its own.
    const held = new Map<Readable, string>()
    const flushHeld = (): void => {
      for (const rest of held.values()) if (rest !== '') line(rest)
      held.clear()
    }
    for (const out of [proc.stdout, proc.stderr]) {
      if (!out) continue
      held.set(out, '')
      out.setEncoding('utf8')
      out.on('data', (c: string) => {
        let buf = (held.get(out) ?? '') + c
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          line(buf.slice(0, i))
          buf = buf.slice(i + 1)
        }
        while (buf.length > STDERR_LINE_MAX) {
          line(buf.slice(0, STDERR_LINE_MAX))
          buf = buf.slice(STDERR_LINE_MAX)
        }
        held.set(out, buf)
      })
    }
    for (const stream of [channel, proc.stdout, proc.stderr]) stream?.on('error', (e) => say(s, `${e.name}: ${e.message}`))
    let ended = false
    const end = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (ended) return
      ended = true
      flushHeld()
      sayDropped(true)
      resolveExit()
      exitedWith(s, proc, code, signal)
    }
    proc.on('exit', (code, signal) => {
      // Give the pipes a moment to deliver their last lines; `close` usually comes first.
      setTimeout(() => end(code, signal), 200)
    })
    proc.on('close', (code, signal) => end(code, signal))
    proc.on('error', (e) => {
      s.problem ??= `it could not be started: ${e.message}`
      end(null, null)
    })
    later(s, t.startMs, () => {
      if (s.proc !== proc || s.state !== 'starting') return
      s.problem = `it did not finish starting within ${t.startMs / 1000} s`
      say(s, s.problem)
      killTree(proc)
    })
    const host = d.host()
    peer
      .request('initialize', {
        apiVersion: '1',
        plugin: { id: p.id, version: p.version, dir: p.dir, entry: p.entry, permissions: [...p.granted], settings: { ...p.settings } },
        host: { version: host.version, pid: host.pid, startedAt: host.startedAt, features: [...host.features] }
      })
      .then(
        (r: unknown) => {
          if (s.proc !== proc || s.state !== 'starting') return
          // Plugin Phase 3 N5: a capability served through a handler its entry does not have fails the start
          const handlers = isObject(r) && Array.isArray(r.handlers) ? r.handlers : []
          for (const c of p.capabilities) {
            const h = (HANDLER_OF[c] ?? []).find((name) => !handlers.includes(name))
            if (h === undefined) continue
            s.problem = `the ${c} capability needs ${h} in its entry`
            say(s, s.problem)
            killTree(proc)
            return
          }
          s.state = 'running'
          s.runningSince = now()
          say(s, 'running')
          s.deliverer?.wake()
        },
        (e: unknown) => {
          if (s.proc !== proc || !s.wanted) return
          s.problem ??= e instanceof Error ? e.message : String(e)
          say(s, `did not start: ${s.problem}`)
          killTree(proc)
        }
      )
  }

  function exitedWith(s: Slot, proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    endGroup(proc.pid)
    if (s.proc !== proc) return
    s.proc = undefined
    s.peer?.close('the plugin exited')
    s.peer = undefined
    say(s, signal ? `exited on signal ${signal}` : `exited with code ${code ?? '?'}`)
    if (!s.wanted) {
      clearTimers(s)
      s.state = 'stopped'
      say(s, 'stopped')
      return
    }
    clearTimers(s)
    crashed(s, s.problem ?? (signal ? `it exited on signal ${signal}` : `it exited with code ${code ?? '?'}`))
  }

  function crashed(s: Slot, problem: string): void {
    const ran = s.runningSince !== undefined ? now() - s.runningSince : 0
    if (ran >= t.stableMs) s.failures = 0
    s.failures += 1
    s.problem = problem
    if (s.failures >= t.failAfter) {
      s.state = 'failed'
      const times = s.failures === 1 ? '' : ` (${s.failures} times in a row, each within ${t.stableMs / 1000} s of starting)`
      // The reason is read by `plugins list`, `get` and `doctor`: hidden like the log (2c final review I3).
      s.reason = hide(s, `${problem}${times}; see astera plugins logs --id ${s.launch.id}`)
      say(s, `failed: ${s.reason}`)
      // The Host log names the plugin only: its message can carry a token, and the plugin's own log has it redacted.
      d.log(`plugins: ${s.launch.id} failed; see astera plugins logs --id ${s.launch.id}`)
      return
    }
    const wait = t.backoffMs[Math.min(s.failures - 1, t.backoffMs.length - 1)] ?? 1000
    s.state = 'waiting'
    say(s, `restarting in ${wait / 1000} s`)
    later(s, wait, () => {
      if (s.wanted && s.state === 'waiting') launch(s)
    })
  }

  const start = (p: PluginLaunch): void => {
    const s = slots.get(p.id)
    if (s && s.wanted && (s.state === 'starting' || s.state === 'running' || s.state === 'waiting')) return
    // A stop still under way finishes first, its cursor written too, so a new deliverer reads where the last one left
    // off; the start follows it.
    const pending = s?.stopping ?? s?.delivering
    if (pending) {
      void pending.then(() => start(p))
      return
    }
    const slot: Slot = s ?? { launch: p, state: 'stopped', wanted: true, failures: 0, timers: new Set(), learned: new Map(), stale: [], attempts: 0 }
    slot.launch = p
    slot.terms = undefined
    slot.wanted = true
    slot.reason = undefined
    if (slot.state !== 'failed') slot.failures = 0
    slots.set(p.id, slot)
    // Kept through crashes and restarts, so the cursor in memory is not read back from the file each time
    if (d.events && delivered(p)) slot.deliverer ??= makeDeliverer(slot, d.events)
    if (slot.state === 'failed') return
    launch(slot)
  }

  const stop = (id: string): Promise<void> => {
    const s = slots.get(id)
    if (!s) return Promise.resolve()
    s.wanted = false
    clearTimers(s)
    // Delivery ends first, so no event goes to a plugin on its way out, and its cursor is written before the stop is
    // over: a removal deletes the file after this, and nothing writes it again (plugin Phase 3 N6)
    if (s.deliverer) {
      sayStale(s)
      const ending: Promise<void> = s.deliverer.stop().finally(() => {
        if (s.delivering === ending) s.delivering = undefined
      })
      s.delivering = ending
      s.deliverer = undefined
    }
    const delivered = s.delivering ?? Promise.resolve()
    const proc = s.proc
    if (!proc) {
      s.state = 'stopped'
      return delivered
    }
    const stopped = (s.stopping ??= (async () => {
      const exited = s.exited ?? Promise.resolve()
      const within = (ms: number): Promise<boolean> =>
        Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))])
      s.peer?.request('shutdown', {}).catch(() => {})
      if (!(await within(t.stopGraceMs))) {
        say(s, `did not stop within ${t.stopGraceMs / 1000} s of shutdown; killing it and what it started`)
        killTree(proc)
        if (!(await within(t.stopGraceMs))) {
          say(s, 'was given up on after the kill')
          if (s.proc === proc) {
            s.proc = undefined
            s.state = 'stopped'
          }
        }
      }
    })().finally(() => {
      s.stopping = undefined
    }))
    return Promise.all([stopped, delivered]).then(() => {})
  }

  function statusOf(id: string): PluginRunStatus | undefined {
    const s = slots.get(id)
    if (!s) return undefined
    const pid = s.proc?.pid
    switch (s.state) {
      case 'running':
        return { status: 'running', ...(pid !== undefined ? { pid } : {}) }
      case 'starting':
        return { status: 'starting', ...(pid !== undefined ? { pid } : {}) }
      case 'waiting':
        return { status: 'starting', reason: hide(s, `restarting after ${s.problem ?? 'a crash'}`) }
      case 'failed':
        return { status: 'failed', ...(s.reason !== undefined ? { reason: s.reason } : {}) }
      default:
        return { status: 'stopped' }
    }
  }

  async function request(id: string, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const s = slots.get(id)
    const peer = s?.peer
    // A plugin that does not run is not asked: a person hears why at once, not after the time limit (Review Focus 3)
    if (!s || s.state !== 'running' || !peer) {
      const st = statusOf(id)
      throw new PluginRequestFailed(503, st ? `${id} is ${st.status}${st.reason ? `: ${st.reason}` : ''}` : `${id} is not running`)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    // Past the time limit the plugin is told (5d): the call's ctx.signal aborts there, and its late answer is dropped
    const ctl = new AbortController()
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new PluginRequestFailed(504, `${id} did not answer within ${timeoutMs / 1000} s`))
        ctl.abort()
      }, timeoutMs)
    })
    try {
      return await Promise.race([peer.request(method, params, { signal: ctl.signal }), late])
    } catch (e) {
      const failure = requestFailure(id, e, (m) => hide(s, m))
      say(s, `${method} failed: ${failure.message}`)
      throw failure
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    start,
    restart: (p) => {
      const s = slots.get(p.id)
      if (s) {
        s.failures = 0
        s.reason = undefined
        if (s.state === 'failed') s.state = 'stopped'
      }
      start(p)
    },
    stop,
    stopAll: async () => {
      await Promise.all([...slots.keys()].map(stop))
      for (const l of logs.values()) l.close()
    },
    status: statusOf,
    logFile,
    request,
    forget: async (folder) => {
      // A removed plugin's slot holds its settings and secret values: they go with it (5d). Only a slot with nothing left
      // to stop: one with a process, a stop or a delivery under way is still the runtime's to end (5d final review M7)
      for (const [id, s] of slots)
        if (s.launch.folder === folder && !s.proc && !s.stopping && !s.delivering && s.timers.size === 0) slots.delete(id)
      logs.delete(folder)
      await releaseLogWriter(logFile(folder))
    }
  }
}
