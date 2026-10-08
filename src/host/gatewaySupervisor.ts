// The Host starts, watches and stops its Remote Gateway (remote runtime design §2.3), in the shape of the MCP HTTP
// supervisor (mcpHttp.ts): a child run through this build's CLI, restarted with backoff, stopped by ending its stdin.
// Two differences, both because this child faces the network. Its stdout is the link to the Host, so it is handed to
// `attach` and never written to any log (it would carry tokens and terminal output, C2 D7.1); its stderr is its
// diagnostics, and every line passes `redactSecrets` on the way to gateway.log (§4.7).
import { spawn as nodeSpawn } from 'node:child_process'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { hostWorkerBaseEnv, type HostCliPaths } from '../core/host/spawn'
import type { RemoteSettings } from '../core/remote/settings'
import { redactSecrets } from '../core/remote/redact'
import type { GatewayLinkFrame } from '../core/remote/frames'
import type { GatewayState } from '../core/remote/gatewayState'
import { openHostLog } from './log'

export const GATEWAY_BACKOFF_MS = [1_000, 2_000, 5_000]
export const GATEWAY_RETRY_MS = 30_000
/** The waits after a named failure in a row (a port another program keeps, an identity it cannot use): 30 s at first,
 *  longer each time, then every ten minutes (performance audit H8). A ready Gateway starts the count again. */
export const GATEWAY_NAMED_RETRY_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000]
/** The longest stderr line kept before it is written in pieces. */
const STDERR_LINE_MAX = 64 * 1024
const STABLE_MS = 30_000
const STOP_GRACE_MS = 5_000
const CLOSE_GRACE_MS = 1_000

export type { GatewayState }

export interface GatewayChild {
  pid?: number
  stdin: Writable | null
  stdout: Readable | null
  stderr: Readable | null
  kill(): boolean
  on(event: 'exit' | 'close', fn: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', fn: (err: Error) => void): this
}

export interface GatewaySpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  stdio: ['pipe', 'pipe', 'pipe']
  windowsHide: true
}

/** What the Host's link gives back for one Gateway generation. */
export interface GatewayLinkLike {
  closeConns(conns: Array<{ linkGen: number; conn: string }>): void
  detach(): void
}

export interface GatewaySupervisor {
  /** Reads the settings again and applies them. A failed Gateway with the same settings is left to its retry cadence
   *  unless `now` (the person's own `runtime start`): an app greeting reloads too, and must not cut it short. */
  reload(o?: { now?: boolean }): Promise<void>
  status(): GatewayState
  /** The live generation's link, for revocation; null while none runs. */
  link(): GatewayLinkLike | null
  /** The hard-cap path (DC-2): kill the Gateway now and let the backoff start a new one. */
  kill(): void
  stop(): Promise<void>
}

export function createGatewaySupervisor(d: {
  settings(): Promise<RemoteSettings>
  cli: HostCliPaths | null
  profileDir: string
  env: NodeJS.ProcessEnv
  spawn?(exec: string, args: string[], opts: GatewaySpawnOptions): GatewayChild
  now?(): number
  setTimer?(fn: () => void, ms: number): () => void
  push(state: GatewayState): void
  /** Connects one Gateway generation's pipes to the Host (gatewayLink.ts). */
  attach(
    child: { stdin: Writable; stdout: Readable },
    linkGen: number,
    events: {
      ready(f: Extract<GatewayLinkFrame, { t: 'gateway-ready' }>): void
      failed(f: Extract<GatewayLinkFrame, { t: 'gateway-failed' }>): void
      hardCap(): void
    }
  ): GatewayLinkLike
  /** Where stderr goes, redacted. Default `<profileDir>/host/gateway.log`, rotated as host.log is. */
  errLog?: { write(message: string): void }
  log(message: string): void
}): GatewaySupervisor {
  const now = d.now ?? Date.now
  const setTimer =
    d.setTimer ??
    ((fn: () => void, ms: number): (() => void) => {
      const t = setTimeout(fn, ms)
      t.unref()
      return () => clearTimeout(t)
    })
  const spawn = d.spawn ?? ((exec: string, args: string[], opts: GatewaySpawnOptions): GatewayChild => nodeSpawn(exec, args, opts))
  let errLog = d.errLog ?? null
  const err = (m: string): void => (errLog ??= openHostLog({ path: path.join(d.profileDir, 'host', 'gateway.log') })).write(redactSecrets(m))

  interface Running {
    proc: GatewayChild
    link: GatewayLinkLike | null
    stopping: boolean
    readyAt: number | null
    failure: { code: string; message: string } | null
    ended: boolean
    onEnd: Array<() => void>
    finish(code: number | null, signal: NodeJS.Signals | null, spawnError?: string): void
  }

  let state: GatewayState = { state: 'disabled' }
  let applied: RemoteSettings | null = null
  let child: Running | null = null
  let cancelRetry: (() => void) | null = null
  let failures = 0
  let linkGen = 0
  let left = false
  let queue: Promise<void> = Promise.resolve()

  const set = (next: GatewayState): void => {
    if (JSON.stringify(next) === JSON.stringify(state)) return
    state = next
    try {
      d.push(next)
    } catch (e) {
      d.log(`remote: the Gateway state could not be pushed: ${String(e)}`)
    }
  }
  const serial = (fn: () => Promise<void>): Promise<void> => {
    const run = queue.then(fn).catch((e) => d.log(`remote: ${String(e)}`))
    queue = run
    return run
  }
  // Past the short tries, an unnamed exit climbs the named waits too (second pass H2-1): a Gateway that crashes at every
  // start was started again every 30 s for the Host's whole life.
  const nextBackoff = (): number => {
    const n = failures++
    return GATEWAY_BACKOFF_MS[n] ?? GATEWAY_NAMED_RETRY_MS[Math.min(n - GATEWAY_BACKOFF_MS.length, GATEWAY_NAMED_RETRY_MS.length - 1)]
  }
  let namedFailures = 0
  const nextNamedWait = (): number => GATEWAY_NAMED_RETRY_MS[Math.min(namedFailures++, GATEWAY_NAMED_RETRY_MS.length - 1)]
  const argsFor = (s: RemoteSettings): string[] => ['runtime', 'gateway', '--listen', s.listen, '--port', String(s.port)]

  const failed = (code: string, message: string, retryMs: number): void => {
    const s = applied
    if (!s) return
    d.log(`remote: the Gateway failed (${code}); trying again in ${retryMs / 1000} s`)
    set({ state: 'failed', code, message, listen: s.listen, port: s.port })
    cancelRetry?.()
    cancelRetry = setTimer(() => {
      cancelRetry = null
      void serial(async () => {
        if (!left && applied) await start()
      })
    }, retryMs)
  }

  const watch = (proc: GatewayChild, s: RemoteSettings): void => {
    let cancelCloseWait: (() => void) | null = null
    const gen = ++linkGen
    const r: Running = {
      proc,
      link: null,
      stopping: false,
      readyAt: null,
      failure: null,
      ended: false,
      onEnd: [],
      finish(code, signal, spawnError) {
        if (r.ended) return
        r.ended = true
        cancelCloseWait?.()
        r.link?.detach()
        if (child === r) child = null
        const how = spawnError ?? (code !== null ? `exited with code ${code}` : `was ended (${signal ?? 'no signal'})`)
        err(`pid ${proc.pid ?? '?'} ${how}`)
        for (const f of r.onEnd.splice(0)) f()
        if (r.stopping || left) return
        if (r.readyAt !== null && now() - r.readyAt >= STABLE_MS) failures = 0
        // A failure the Gateway named (a bind or identity problem) does not get better in a second: the 30 s cadence.
        if (r.failure) return failed(r.failure.code, r.failure.message, nextNamedWait())
        failed('GATEWAY_EXITED', spawnError ? `could not start the Gateway: ${spawnError}` : `the Gateway ${how}`, nextBackoff())
      }
    }
    child = r
    if (proc.stdin && proc.stdout)
      r.link = d.attach({ stdin: proc.stdin, stdout: proc.stdout }, gen, {
        ready: (f) => {
          if (r.ended || r.stopping) return
          r.readyAt = now()
          namedFailures = 0
          d.log(`remote: the Gateway listens on ${f.address}:${f.port} (pid ${proc.pid ?? '?'})`)
          set({ state: 'ready', listen: s.listen, port: f.port, fingerprint: f.fingerprint })
        },
        failed: (f) => {
          r.failure = { code: f.code, message: f.message }
        },
        hardCap: () => {
          d.log('remote: the Gateway stopped reading its link; killing it')
          killNow(r)
        }
      })
    let buffered = ''
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (c: string) => {
      buffered += c
      for (let i = buffered.indexOf('\n'); i >= 0; i = buffered.indexOf('\n')) {
        const line = buffered.slice(0, i).trim()
        buffered = buffered.slice(i + 1)
        if (line !== '') err(line)
      }
      // A line that never ends is written in pieces (Phase 3 minor), so a Gateway stuck printing cannot grow this.
      while (buffered.length > STDERR_LINE_MAX) {
        err(buffered.slice(0, STDERR_LINE_MAX))
        buffered = buffered.slice(STDERR_LINE_MAX)
      }
    })
    proc.stdin?.on('error', (e) => d.log(`remote: Gateway stdin: ${e.name}`))
    proc.stdout?.on('error', (e) => d.log(`remote: Gateway stdout: ${e.name}`))
    proc.stderr?.on('error', (e) => d.log(`remote: Gateway stderr: ${e.name}`))
    proc.on('close', (code, signal) => r.finish(code, signal))
    proc.on('exit', (code, signal) => {
      if (!r.ended) cancelCloseWait = setTimer(() => r.finish(code, signal), CLOSE_GRACE_MS)
    })
    proc.on('error', (e) => r.finish(null, null, String(e)))
  }

  const killNow = (r: Running): void => {
    try {
      r.proc.kill()
    } catch (e) {
      d.log(`remote: could not kill the Gateway: ${String(e)}`)
    }
  }

  const start = async (): Promise<void> => {
    const s = applied
    if (!s || !d.cli) return
    cancelRetry?.()
    cancelRetry = null
    set({ state: 'starting', listen: s.listen, port: s.port })
    let proc: GatewayChild
    try {
      proc = spawn(d.cli.exec, [d.cli.entry, ...argsFor(s)], {
        cwd: d.profileDir,
        env: { ...hostWorkerBaseEnv(d.env), ASTERA_PROFILE_DIR: d.profileDir, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (e) {
      return failed('GATEWAY_EXITED', `could not start the Gateway: ${String(e)}`, nextBackoff())
    }
    err(`started pid ${proc.pid ?? '?'} on ${s.listen}:${s.port}`)
    watch(proc, s)
  }

  const stopChild = async (): Promise<void> => {
    cancelRetry?.()
    cancelRetry = null
    const r = child
    if (!r) return
    r.stopping = true
    const ended = new Promise<void>((resolve) => r.onEnd.push(resolve))
    try {
      r.proc.stdin?.end()
    } catch (e) {
      d.log(`remote: could not end the Gateway's stdin: ${String(e)}`)
    }
    let cancelGiveUp = (): void => {}
    const cancelKill = setTimer(() => {
      killNow(r)
      cancelGiveUp = setTimer(() => r.finish(null, null, 'was given up on after the kill'), STOP_GRACE_MS)
    }, STOP_GRACE_MS)
    await ended
    cancelKill()
    cancelGiveUp()
  }

  return {
    reload: (o = {}) =>
      serial(async () => {
        if (left) return
        let s: RemoteSettings
        try {
          s = await d.settings()
        } catch (e) {
          d.log(`remote: remote-runtime.json could not be read; keeping what runs: ${e instanceof Error ? e.message : String(e)}`)
          return
        }
        if (!s.enabled) {
          await stopChild()
          applied = null
          return set({ state: 'disabled' })
        }
        if (!d.cli) {
          applied = null
          return set({ state: 'failed', code: 'NO_CLI_PATHS', message: 'this Host was started without the CLI paths, so it cannot start the Gateway' })
        }
        if (applied && applied.listen === s.listen && applied.port === s.port && child) return
        // Failed with these settings and a retry already set (Phase 3 minor): the cadence decides, unless asked now.
        if (applied && applied.listen === s.listen && applied.port === s.port && cancelRetry && o.now !== true) return
        cancelRetry?.()
        cancelRetry = null
        await stopChild()
        applied = s
        failures = 0
        // A new setting (or the person's own retry) is not made to wait what the old one earned (final review M5)
        namedFailures = 0
        await start()
      }),
    status: () => state,
    link: () => child?.link ?? null,
    kill: () => {
      if (child) killNow(child)
    },
    stop: () => {
      left = true
      return serial(async () => {
        await stopChild()
        applied = null
        set({ state: 'disabled' })
      })
    }
  }
}
