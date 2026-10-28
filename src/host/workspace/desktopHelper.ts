// The Host's side of one desktop helper (agent workspace design, Components 2): starts it, waits for
// `ready` (5 s, else a clear error), creates the desktop, serialises requests, and rejects every
// pending request if the process dies. A request unanswered for 15 s ends the helper (a hung window
// must not block every later call), and `close` resolves once the process has exited, all within one
// 5 s deadline. This is the Windows `Desk` (src/core/workspace/helpers.ts).
//
// The process is behind `DeskProcess` so the tests answer it by hand; `spawnPowerShell` is the real
// one, the clipboardFiles.ts route (powershell.exe, windowsHide, no shell).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { shellSpawn } from '../../core/run/shell'
import { NOT_INTERACTIVE } from '../../core/workspace/lifecycle'
import {
  DESK_CLOSE_MS,
  DESK_READY_MS,
  DESK_REQUEST_MS,
  asLaunched,
  asShot,
  asWindows,
  encodeDeskRequest,
  parseDeskLine,
  type DeskRequest,
  type DeskRequestBody
} from '../../core/workspace/protocol'
import type { Desk } from '../../core/workspace/helpers'
import { DESK_PS1 } from './desk'

export interface DeskProcess {
  readonly pid: number | undefined
  write(line: string): void
  /** Every stdout line, without its `\n`. */
  onLine(cb: (line: string) => void): void
  /** Once, however it ended: an exit, a failed start. */
  onExit(cb: (why: string) => void): void
  kill(): void
}

export type SpawnDesk = () => DeskProcess

export interface DesktopHelper extends Desk {
  readonly pid: number
  readonly startedAt: number
  alive(): boolean
  onExit(cb: (why: string) => void): void
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Plan ruling P5: the embedded script, written under a content name so an older one is never run. */
export async function writeDeskScript(dir: string): Promise<string> {
  const hash = createHash('sha256').update(DESK_PS1).digest('hex').slice(0, 8)
  const file = path.join(dir, `desk-${hash}.ps1`)
  const current = await fs.readFile(file, 'utf8').catch(() => null)
  if (current !== DESK_PS1) {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, DESK_PS1, 'utf8')
  }
  return file
}

export function spawnPowerShell(scriptPath: string): DeskProcess {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const lineCbs: Array<(l: string) => void> = []
  const exitCbs: Array<(why: string) => void> = []
  let buf = ''
  let stderrTail = ''
  let ended = false
  const end = (why: string): void => {
    if (ended) return
    ended = true
    for (const cb of exitCbs) cb(why)
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buf += chunk
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      for (const cb of lineCbs) cb(line)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c: string) => {
    stderrTail = (stderrTail + c).slice(-2_000)
  })
  child.stdin.on('error', () => {
    /* a write after the exit; the exit reports it */
  })
  child.on('error', (err) => end(`powershell.exe could not start: ${err.message}`))
  // 'close', not 'exit': 'exit' can come before stdout has drained, and the last reply (close's) would
  // be lost. The helper launches with bInheritHandles false, so nothing else holds these pipes open.
  child.on('close', (code, signal) => {
    if (buf !== '') {
      const line = buf
      buf = ''
      for (const cb of lineCbs) cb(line)
    }
    const tail = stderrTail.trim().replace(/\s+/g, ' ')
    end(`exited ${String(signal ?? code)}${tail ? `: ${tail}` : ''}`)
  })
  return {
    get pid() {
      return child.pid
    },
    write: (line) => {
      if (!ended && child.stdin.writable) child.stdin.write(line)
    },
    onLine: (cb) => {
      lineCbs.push(cb)
    },
    onExit: (cb) => {
      exitCbs.push(cb)
    },
    kill: () => {
      if (!ended) child.kill()
    }
  }
}

export async function startDesktopHelper(a: { name: string; spawn: SpawnDesk; readyMs?: number; log(m: string): void }): Promise<DesktopHelper> {
  const readyMs = a.readyMs ?? DESK_READY_MS
  const proc = a.spawn()
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  const exitCbs: Array<(why: string) => void> = []
  let nextId = 1
  let dead: string | null = null
  let tail: Promise<unknown> = Promise.resolve()
  let readyResolve!: (hello: { interactive: boolean; pid: number; startedAt: number }) => void
  let readyReject!: (e: Error) => void
  const ready = new Promise<{ interactive: boolean; pid: number; startedAt: number }>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })

  proc.onLine((line) => {
    const m = parseDeskLine(line)
    if (m === null) {
      // Review Focus 2: noise is logged and never fatal.
      if (line.trim() !== '') a.log(`desktop helper ${a.name} wrote a line that is not a message: ${line.trim().slice(0, 200)}`)
      return
    }
    if (m.kind === 'ready') return readyResolve(m)
    if (m.kind === 'fatal') return readyReject(new Error(`the desktop helper could not start: ${m.error}`))
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.ok) p.resolve(m.value)
    else p.reject(new Error(m.error))
  })
  let exitedResolve!: () => void
  const exited = new Promise<'exited'>((resolve) => {
    exitedResolve = () => resolve('exited')
  })
  proc.onExit((why) => {
    dead = why
    exitedResolve()
    readyReject(new Error(`the desktop helper ended before it was ready (${why})`))
    for (const [id, p] of pending) {
      pending.delete(id)
      p.reject(new Error(`the desktop helper ended (${why})`))
    }
    for (const cb of exitCbs) {
      try {
        cb(why)
      } catch (err) {
        a.log(`a desktop helper exit listener threw: ${String(err)}`)
      }
    }
  })

  const timer = setTimeout(() => readyReject(new Error(`the desktop helper did not say ready within ${readyMs / 1000} s`)), readyMs)
  let hello: { interactive: boolean; pid: number; startedAt: number }
  try {
    hello = await ready
  } catch (err) {
    proc.kill()
    throw err
  } finally {
    clearTimeout(timer)
  }
  if (!hello.interactive) {
    proc.kill()
    throw new Error(NOT_INTERACTIVE)
  }

  /** One request in flight at a time: the helper is one thread attached to one desktop. One left
   *  unanswered for `ms` is taken as a hung helper: it rejects, the helper is ended, and every later
   *  request rejects at once (the exit, when it comes, finds nothing pending). */
  const request = (body: DeskRequestBody, ms: number = DESK_REQUEST_MS): Promise<unknown> => {
    const run = (): Promise<unknown> =>
      new Promise((resolve, reject) => {
        if (dead !== null) return reject(new Error(`the desktop helper ended (${dead})`))
        const id = nextId++
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return
          const why = `did not answer ${body.op} within ${ms / 1000} s`
          dead ??= `it ${why}`
          a.log(`desktop helper ${a.name} ${why}; ending it`)
          reject(new Error(`the desktop helper ${why}`))
          proc.kill()
        }, ms)
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer)
            resolve(v)
          },
          reject: (e) => {
            clearTimeout(timer)
            reject(e)
          }
        })
        proc.write(encodeDeskRequest({ ...body, id } as DeskRequest))
      })
    const p = tail.then(run, run)
    tail = p.catch(() => undefined)
    return p
  }

  try {
    await request({ op: 'create', name: a.name })
  } catch (err) {
    proc.kill()
    throw new Error(`the desktop could not be created: ${messageOf(err)}`)
  }

  return {
    name: a.name,
    pid: hello.pid,
    startedAt: hello.startedAt,
    alive: () => dead === null,
    onExit: (cb) => {
      exitCbs.push(cb)
    },
    launch: async ({ command, cwd, env }) => {
      // The Desk port takes a shell command (W7); this is where it becomes a Windows command line,
      // by the same rule a Run uses (shellSpawn's win32 string form).
      const s = shellSpawn(command, 'win32')
      const v = await request({ op: 'launch', commandLine: `${s.file} ${String(s.args)}`, cwd, env })
      const launched = asLaunched(v)
      // A launch the helper could not put in a job of its own still runs (desk.ts, Launch); only its
      // end is weaker, so it is said here.
      if (typeof v === 'object' && v !== null && (v as { job?: unknown }).job === false)
        a.log(
          `desktop helper ${a.name} launched pid ${launched.pid} without a job object (${String((v as { jobError?: unknown }).jobError ?? 'no reason given')}); ` +
            'ending it falls back to taskkill /T, which misses a child whose parent has already exited'
        )
      return launched
    },
    kill: async (pid, startedAt) => {
      const v = await request({ op: 'kill', pid, startedAt })
      // A pid that is gone or was reused is left alone by the helper; that is an answer, not a failure.
      if (typeof v === 'object' && v !== null && (v as { killed?: unknown }).killed === false)
        a.log(`desktop helper ${a.name} did not kill pid ${pid}: ${String((v as { reason?: unknown }).reason ?? 'no reason given')}`)
    },
    windows: async () => asWindows(await request({ op: 'windows' })),
    shot: async (o) => asShot(await request({ op: 'shot', title: o.title ?? null, format: o.format, maxWidth: o.maxWidth ?? null })),
    keys: async (o) => {
      await request({ op: 'keys', title: o.title, text: o.text ?? null, key: o.key ?? null })
    },
    close: async () => {
      // Preflight ruling F2: one deadline for the whole close, the request and the exit together, and
      // resolve only once the process is gone, so a leftover check that follows never sees it running.
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), DESK_CLOSE_MS)
      })
      try {
        if (dead === null) {
          const asked = request({ op: 'close' }, DESK_CLOSE_MS).catch((err: unknown) =>
            a.log(`desktop helper ${a.name} did not close cleanly: ${messageOf(err)}`)
          )
          await Promise.race([asked, late])
        }
        proc.kill()
        if ((await Promise.race([exited, late])) === 'late')
          a.log(`desktop helper ${a.name} did not exit within ${DESK_CLOSE_MS / 1000} s of close`)
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
