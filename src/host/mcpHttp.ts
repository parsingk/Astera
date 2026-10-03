// The Host starts, watches and stops the MCP HTTP entrance (MCP HTTP F1 design §3): `astera mcp http`, a
// child process of this Host, run through this build's CLI the way a worker's shuttle runs it.
//
// The child's whole protocol is one JSON line on stdout (`{"ready":true,"port":n}` once listening, or
// `{"error":code,"message":text}` before a failing exit) and its stdin: it leaves when its stdin ends, so a
// stop ends stdin first and kills only after a grace. A Host that dies ends that pipe too, so the
// entrance never outlives it. Its output goes to its own log beside host.log, never into host.log.
import { spawn as nodeSpawn } from 'node:child_process'
import path from 'node:path'
import type { McpHttpState } from '../core/host/protocol'
import { hostWorkerBaseEnv, type HostCliPaths } from '../core/host/spawn'
import { ensureToken, tokenPath } from '../core/mcp/httpToken'
import { MCP_HTTP_DEFAULT_PORT, type McpHttpSettings } from '../core/settings/mcpHttp'
import { openHostLog } from './log'

/** Restart delays after an unexpected exit, in order; past the last, every MCP_HTTP_RETRY_MS (design §3). */
export const MCP_HTTP_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000]
/** The steady retry: past the backoff, and at once for a port already in use. */
export const MCP_HTTP_RETRY_MS = 30_000
/** A child that stayed up this long after its ready line starts the backoff over when it exits. */
const STABLE_MS = 30_000
/** How long a stop waits after ending stdin before it kills, and again after the kill before it gives up. */
const STOP_GRACE_MS = 5_000
/** How long an 'exit' waits for its 'close' (the last output) before it counts as the end. */
const CLOSE_GRACE_MS = 1_000

export const NO_CLI_PATHS = 'this Host cannot start the HTTP entrance'

/** The part of a child process the supervisor uses; a ChildProcess spawned with three pipes is one. */
export interface McpHttpChild {
  readonly pid?: number
  readonly stdin: NodeJS.WritableStream | null
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  kill(): boolean
  on(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (err: Error) => void): this
}

export interface McpHttpSpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  stdio: ['pipe', 'pipe', 'pipe']
  windowsHide: true
}

export interface McpHttpSupervisor {
  /** Reads the setting again and applies it: starts, restarts with the new arguments, or stops. A setting
   *  that cannot be read keeps what runs. Calls run one at a time. Never rejects. `retry` is a person's
   *  `mcp-http-reload`: a failed entrance with the same setting is tried again at once and the backoff starts
   *  over. Without it (start, an app greeting) a failed entrance keeps its wait. */
  reload(o?: { retry?: boolean }): Promise<void>
  status(): McpHttpState
  /** The Host leaves: stops the child and every pending restart, and nothing starts after it. Never rejects. */
  stop(): Promise<void>
}

export function createMcpHttpSupervisor(d: {
  settings(): Promise<McpHttpSettings>
  /** Null when this Host was started without the CLI paths: it then reports `failed` (NO_CLI_PATHS). */
  cli: HostCliPaths | null
  profileDir: string
  /** This Host's own address, so the child reaches its parent whatever ASTERA_HOST the Host inherited. */
  hostAddress: string
  /** The Host's environment; the child gets hostWorkerBaseEnv of it plus its own three variables. */
  env: NodeJS.ProcessEnv
  spawn?(exec: string, args: string[], opts: McpHttpSpawnOptions): McpHttpChild
  now?(): number
  /** Runs `fn` after `ms`; returns the cancel. */
  setTimer?(fn: () => void, ms: number): () => void
  push(state: McpHttpState): void
  /** Where the child's output goes. Default: `<profileDir>/host/mcp-http.log`, rotated as host.log is. */
  output?: { write(message: string): void }
  /** host.log. */
  log(message: string): void
}): McpHttpSupervisor {
  const now = d.now ?? Date.now
  const setTimer =
    d.setTimer ??
    ((fn: () => void, ms: number): (() => void) => {
      const t = setTimeout(fn, ms)
      t.unref()
      return () => clearTimeout(t)
    })
  const spawn = d.spawn ?? ((exec: string, args: string[], opts: McpHttpSpawnOptions): McpHttpChild => nodeSpawn(exec, args, opts))
  let output = d.output ?? null
  const out = (m: string): void => (output ??= openHostLog({ path: path.join(d.profileDir, 'host', 'mcp-http.log') })).write(m)

  interface Running {
    proc: McpHttpChild
    stopping: boolean
    readyAt: number | null
    ended: boolean
    onEnd: Array<() => void>
    finish(code: number | null, signal: NodeJS.Signals | null, spawnError?: string): void
  }

  let state: McpHttpState = { state: 'off', lan: false, port: MCP_HTTP_DEFAULT_PORT }
  /** The enabled setting being applied, or null while off. */
  let applied: McpHttpSettings | null = null
  let child: Running | null = null
  let cancelRetry: (() => void) | null = null
  /** Unexpected ends since the last start over: indexes MCP_HTTP_BACKOFF_MS. */
  let failures = 0
  let left = false
  let queue: Promise<void> = Promise.resolve()

  const set = (next: McpHttpState): void => {
    if (next.state === state.state && next.url === state.url && next.error === state.error && next.lan === state.lan && next.port === state.port) return
    state = next
    try {
      d.push(next)
    } catch (err) {
      d.log(`mcp http: the state could not be pushed: ${String(err)}`)
    }
  }

  /** One at a time, and never a rejection: a reload, a retry and the stop each see the last one finished. */
  const serial = (fn: () => Promise<void>): Promise<void> => {
    const run = queue.then(fn).catch((err) => d.log(`mcp http: ${String(err)}`))
    queue = run
    return run
  }

  /** Hosts are passed only with other devices allowed: they widen who may call, which is the LAN's question. */
  const argsFor = (s: McpHttpSettings): string[] => {
    const hosts = s.lan ? s.hosts.map((h) => h.trim()).filter((h) => h !== '' && !h.includes(',')) : []
    return [
      ...['mcp', 'http', '--port', String(s.port), '--bind', s.lan ? '0.0.0.0' : '127.0.0.1', '--token-file', tokenPath(d.profileDir)],
      ...(hosts.length > 0 ? ['--hosts', hosts.join(',')] : [])
    ]
  }
  const sameArgs = (a: McpHttpSettings, b: McpHttpSettings): boolean => JSON.stringify(argsFor(a)) === JSON.stringify(argsFor(b))

  const failed = (error: string, retryMs: number): void => {
    const s = applied
    if (!s) return
    d.log(`mcp http: ${error}; trying again in ${retryMs / 1000} s`)
    set({ state: 'failed', error, lan: s.lan, port: s.port })
    cancelRetry?.()
    cancelRetry = setTimer(() => {
      cancelRetry = null
      void serial(async () => {
        if (!left && applied) await start()
      })
    }, retryMs)
  }
  const nextBackoff = (): number => MCP_HTTP_BACKOFF_MS[failures++] ?? MCP_HTTP_RETRY_MS

  const watch = (proc: McpHttpChild, s: McpHttpSettings): void => {
    let errorLine: { code: string; message: string } | null = null
    let cancelCloseWait: (() => void) | null = null
    const r: Running = {
      proc,
      stopping: false,
      readyAt: null,
      ended: false,
      onEnd: [],
      finish(code, signal, spawnError) {
        if (r.ended) return
        r.ended = true
        cancelCloseWait?.()
        if (child === r) child = null
        const how = spawnError ?? (code !== null ? `exited with code ${code}` : `was ended (${signal ?? 'no signal'})`)
        out(`pid ${proc.pid ?? '?'} ${how}`)
        for (const f of r.onEnd.splice(0)) f()
        if (r.stopping || left) return
        if (r.readyAt !== null && now() - r.readyAt >= STABLE_MS) failures = 0
        if (errorLine?.code === 'EADDRINUSE') return failed(`EADDRINUSE: ${errorLine.message}`, MCP_HTTP_RETRY_MS)
        failed(
          errorLine ? `${errorLine.code}: ${errorLine.message}` : spawnError ? `could not start the HTTP entrance: ${spawnError}` : `the HTTP entrance ${how}`,
          nextBackoff()
        )
      }
    }
    child = r
    const onLine = (line: string): void => {
      out(`stdout: ${line}`)
      let v: unknown
      try {
        v = JSON.parse(line)
      } catch {
        return
      }
      if (typeof v !== 'object' || v === null) return
      const o = v as Record<string, unknown>
      if (o.ready === true && typeof o.port === 'number') {
        if (r.ended || r.stopping) return
        r.readyAt = now()
        d.log(`mcp http: listening on port ${o.port} (pid ${proc.pid ?? '?'})`)
        set({ state: 'running', url: `http://127.0.0.1:${o.port}/mcp`, lan: s.lan, port: s.port })
      } else if (typeof o.error === 'string') {
        errorLine = { code: o.error, message: typeof o.message === 'string' ? o.message : '' }
      }
    }
    /** Whole lines out of a stream's chunks: a chunk can end mid-line. */
    const lines = (stream: NodeJS.ReadableStream | null, each: (line: string) => void): void => {
      let buffered = ''
      stream?.setEncoding('utf8')
      stream?.on('data', (c: string) => {
        buffered += c
        for (let i = buffered.indexOf('\n'); i >= 0; i = buffered.indexOf('\n')) {
          const line = buffered.slice(0, i).trim()
          buffered = buffered.slice(i + 1)
          if (line !== '') each(line)
        }
      })
    }
    lines(proc.stdout, onLine)
    lines(proc.stderr, out)
    // A pipe that closes under a write emits 'error' on that stream alone, which unheard would end the Host.
    proc.stdin?.on('error', (err) => d.log(`mcp http: stdin: ${String(err)}`))
    proc.stdout?.on('error', (err) => d.log(`mcp http: stdout: ${String(err)}`))
    proc.stderr?.on('error', (err) => d.log(`mcp http: stderr: ${String(err)}`))
    // 'close' is when the last output has been read; 'exit' only arms a wait for it.
    proc.on('close', (code, signal) => r.finish(code, signal))
    proc.on('exit', (code, signal) => {
      if (!r.ended) cancelCloseWait = setTimer(() => r.finish(code, signal), CLOSE_GRACE_MS)
    })
    proc.on('error', (err) => r.finish(null, null, String(err)))
  }

  const start = async (): Promise<void> => {
    const s = applied
    if (!s || !d.cli) return
    cancelRetry?.()
    cancelRetry = null
    set({ state: 'starting', lan: s.lan, port: s.port })
    try {
      await ensureToken(d.profileDir)
    } catch (err) {
      return failed(`could not create the token file: ${String(err)}`, nextBackoff())
    }
    let proc: McpHttpChild
    try {
      proc = spawn(d.cli.exec, [d.cli.entry, ...argsFor(s)], {
        cwd: d.profileDir,
        env: { ...hostWorkerBaseEnv(d.env), ASTERA_PROFILE_DIR: d.profileDir, ASTERA_HOST: d.hostAddress, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (err) {
      return failed(`could not start the HTTP entrance: ${String(err)}`, nextBackoff())
    }
    out(`started pid ${proc.pid ?? '?'} on port ${s.port}${s.lan ? ', other devices allowed' : ''}`)
    watch(proc, s)
  }

  /** Ends the child's stdin, kills it after the grace, and gives up waiting after one more. */
  const stopChild = async (): Promise<void> => {
    cancelRetry?.()
    cancelRetry = null
    const r = child
    if (!r) return
    r.stopping = true
    const ended = new Promise<void>((resolve) => r.onEnd.push(resolve))
    try {
      r.proc.stdin?.end()
    } catch (err) {
      d.log(`mcp http: could not end stdin: ${String(err)}`)
    }
    let cancelGiveUp = (): void => {}
    const cancelKill = setTimer(() => {
      d.log(`mcp http: pid ${r.proc.pid ?? '?'} did not leave ${STOP_GRACE_MS / 1000} s after its stdin ended; killing it`)
      try {
        r.proc.kill()
      } catch (err) {
        d.log(`mcp http: could not kill it: ${String(err)}`)
      }
      cancelGiveUp = setTimer(() => r.finish(null, null, 'was given up on after the kill'), STOP_GRACE_MS)
    }, STOP_GRACE_MS)
    await ended
    cancelKill()
    cancelGiveUp()
  }

  return {
    reload: (o) =>
      serial(async () => {
        if (left) return
        let s: McpHttpSettings
        try {
          s = await d.settings()
        } catch (err) {
          d.log(`mcp http: the setting could not be read; keeping what runs: ${String(err)}`)
          return
        }
        if (!s.enabled) {
          await stopChild()
          applied = null
          return set({ state: 'off', lan: s.lan, port: s.port })
        }
        if (!d.cli) {
          applied = null
          return set({ state: 'failed', error: NO_CLI_PATHS, lan: s.lan, port: s.port })
        }
        // The same setting: nothing to do, unless the entrance failed and a person asked to try again now.
        if (applied && sameArgs(applied, s) && !(o?.retry === true && state.state === 'failed')) return
        await stopChild()
        applied = s
        failures = 0
        await start()
      }),
    status: () => state,
    stop: () => {
      left = true
      return serial(async () => {
        await stopChild()
        applied = null
        set({ state: 'off', lan: state.lan, port: state.port })
      })
    }
  }
}
