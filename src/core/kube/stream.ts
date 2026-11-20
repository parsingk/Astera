import { spawn, type ChildProcess } from 'node:child_process'
import { killProcessTree } from '../run/kill'

export interface KubectlStream {
  stop(): void
}

export interface StreamExit {
  code: number | null
  /** True when stop() ended it, so a caller can tell its own stop from kubectl ending by itself. */
  stopped: boolean
  /** Set only when kubectl could not be started (ENOENT when the binary is missing). */
  errorCode?: string
}

/** A spawn refused by Windows under load (EPERM/EBUSY); nothing started, so one retry is safe (as runKubectl does). */
const SPAWN_TRANSIENT = new Set(['EPERM', 'EBUSY'])
const RETRY_DELAY_MS = 50

/** Runs a long-lived kubectl (a watch, later `logs -f`) with no shell and reports its output as it comes.
 *  `onExit` fires exactly once, and no output is delivered after it. After stop() it reports `stopped: true` as soon
 *  as kubectl itself has exited (at once if it already had), not when the output pipes close, which a grandchild can
 *  hold open for as long as it lives. */
export function streamKubectl(
  args: string[],
  o: {
    bin: string
    env?: NodeJS.ProcessEnv
    onStdout(chunk: string): void
    onStderr(chunk: string): void
    onExit(e: StreamExit): void
  }
): KubectlStream {
  let child: ChildProcess | null = null
  let stopped = false
  let done = false
  const finish = (e: { code: number | null; errorCode?: string }): void => {
    if (done) return
    done = true
    o.onExit({ ...e, stopped })
  }
  const start = (retried: boolean): void => {
    let c: ChildProcess
    try {
      c = spawn(o.bin, args, { env: o.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      const code = (err as { code?: unknown }).code
      finish({ code: null, errorCode: typeof code === 'string' ? code : 'SPAWN' })
      return
    }
    child = c
    c.stdout?.setEncoding('utf8')
    c.stderr?.setEncoding('utf8')
    // Nothing after onExit: a stop answers on 'exit', and the pipes can still bring what was left in them.
    c.stdout?.on('data', (d: string) => {
      if (!done) o.onStdout(d)
    })
    c.stderr?.on('data', (d: string) => {
      if (!done) o.onStderr(d)
    })
    c.once('error', (err: NodeJS.ErrnoException) => {
      if (!retried && !stopped && err.code && SPAWN_TRANSIENT.has(err.code)) {
        child = null
        setTimeout(() => {
          if (stopped) finish({ code: null })
          else start(true)
        }, RETRY_DELAY_MS)
        return
      }
      finish({ code: null, errorCode: err.code ?? 'SPAWN' })
    })
    // 'close' (not 'exit') so the last output lands before the exit report; a stop answers on 'exit' instead.
    c.once('close', (code) => finish({ code }))
    c.once('exit', (code) => {
      if (stopped) finish({ code })
    })
  }
  start(false)
  return {
    stop(): void {
      if (stopped || done) return
      stopped = true
      if (!child) return
      // kubectl has exited and only its pipes are open, held by a child it left: its 'exit' is past, nothing to wait for.
      if (child.exitCode !== null || child.signalCode !== null) return finish({ code: child.exitCode })
      killProcessTree(child)
    }
  }
}
