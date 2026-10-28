// A minimal client for `codex app-server` (one JSON-RPC message per line over stdio), for the S2 measurement: enough to
// send initialize, the initialized notification, thread/start and command/exec, and to read their answers. It starts
// no turn, so no model is called. The framing is the app's own (src/core/chat/codexProtocol.ts), so this module loads
// under vitest only.
import { spawn } from 'node:child_process'
import { UNSUPPORTED_REQUEST, decodeFrame, encodeError, encodeNotification, encodeRequest } from '../../src/core/chat/codexProtocol'

const STDERR_KEEP = 4000

/**
 * Starts the server. `request` resolves to `{ result }` or `{ error }`, or with `timedOut` or `exited` set when no
 * answer came; it never rejects, so a set records what happened instead of stopping. A request from the server is
 * answered with an error at once: the measurement grants nothing, and an unanswered request would leave it waiting.
 */
export function startAppServer({ file, args, cwd, env }) {
  const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const pending = new Map()
  const notifications = []
  let nextId = 1
  let buffered = ''
  let stderr = ''
  let exited = null
  let spawnError = null
  let onExit = []

  const finish = (how) => {
    if (exited !== null) return
    exited = how
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.resolve({ exited: true, error: { code: -1, message: `app-server exited (${how.error ?? how.code ?? how.signal}) before answering ${p.method}` } })
    }
    pending.clear()
    for (const f of onExit) f(exited)
    onExit = []
  }
  const write = (line) => {
    if (exited === null && child.stdin.writable) child.stdin.write(`${line}\n`)
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    buffered += d
    for (let i = buffered.indexOf('\n'); i >= 0; i = buffered.indexOf('\n')) {
      const frame = decodeFrame(buffered.slice(0, i).trim())
      buffered = buffered.slice(i + 1)
      if (frame === null) continue
      if (frame.kind === 'notification') notifications.push(frame.method)
      else if (frame.kind === 'request') write(encodeError(frame.id, UNSUPPORTED_REQUEST, 'the measurement answers no requests'))
      else {
        const p = pending.get(frame.id)
        if (p === undefined) continue
        pending.delete(frame.id)
        clearTimeout(p.timer)
        p.resolve(frame.error ? { error: frame.error } : { result: frame.result })
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-STDERR_KEEP)
  })
  // A write after the server has gone would otherwise throw out of the stream
  child.stdin.on('error', () => {})
  child.on('error', (err) => {
    spawnError = String(err.code ?? err.message)
    finish({ code: null, signal: null, error: spawnError })
  })
  child.on('exit', (code, signal) => finish({ code, signal }))

  return {
    pid: child.pid,
    request(method, params, timeoutMs = 30_000) {
      if (exited !== null) return Promise.resolve({ exited: true, error: { code: -1, message: `app-server had exited before ${method}` } })
      const id = nextId++
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          resolve({ timedOut: true, error: { code: -1, message: `no answer to ${method} in ${timeoutMs} ms` } })
        }, timeoutMs)
        pending.set(id, { method, resolve, timer })
        write(encodeRequest(id, method, params))
      })
    },
    notify(method, params) {
      write(encodeNotification(method, params))
    },
    notifications: () => [...notifications],
    stderr: () => stderr,
    spawnError: () => spawnError,
    /** Closes stdin, which ends the server. If it has not ended after `graceMs`, sends this one process SIGTERM, after
     *  `termMs` more SIGKILL, and after `killMs` more answers anyway, so a case never waits past its own time on a
     *  server that ignores both (review). */
    stop({ graceMs = 5000, termMs = 5000, killMs = 2000 } = {}) {
      if (exited !== null) return Promise.resolve(exited)
      return new Promise((resolve) => {
        const timers = []
        const done = (how) => {
          for (const t of timers) clearTimeout(t)
          resolve(how)
        }
        onExit.push(done)
        timers.push(setTimeout(() => child.kill('SIGTERM'), graceMs))
        timers.push(setTimeout(() => child.kill('SIGKILL'), graceMs + termMs))
        timers.push(setTimeout(() => done({ code: null, signal: 'SIGKILL', forced: true }), graceMs + termMs + killMs))
        child.stdin.end()
      })
    }
  }
}
