// child_process behind RegistryProc — what the Host really spawns for a line process. The registry
// decides where lines end; this only delivers chunks, writes bytes, and reports the exit.
//
// Imports nothing outside core/host (the Host bundle rule), so the process-tree kill is written here
// rather than imported from core/run/kill.ts — the same two lines.
import { spawn } from 'node:child_process'
import type { ProcOpenOptions } from '../core/host/protocol'
import { createStderrTail } from '../core/sessions/stderrTail'
import type { RegistryProc, RegistryProcSpawn } from './procRegistry'

export function nodeProcSpawn(a: { log(m: string): void; platform: NodeJS.Platform }): RegistryProcSpawn {
  return (file: string, args: string[], opts: ProcOpenOptions): RegistryProc => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      // A console-subsystem child of a console-less parent gets a new console on Windows — the flashing
      // window fixed once already (fix(win) in 1.3.21). Always hidden here.
      windowsHide: true
    })
    let onData: (chunk: string) => void = () => {}
    let onExit: (e: { exitCode: number; stderrTail?: string }) => void = () => {}
    let ended = false
    let exitTimer: NodeJS.Timeout | null = null
    const tail = createStderrTail()
    const end = (code: number): void => {
      if (ended) return
      ended = true
      if (exitTimer) {
        clearTimeout(exitTimer)
        exitTimer = null
      }
      onExit({ exitCode: code, ...(tail.value() !== undefined ? { stderrTail: tail.value() } : {}) })
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => onData(c))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (c: string) => {
      // The log stays: it is where someone digging into a Host that outlived its app looks. The tail is
      // the same words on their way to the screen, which the log could never reach (design D1).
      tail.push(c)
      a.log(`proc pid ${child.pid ?? '?'} stderr: ${c.trim().slice(0, 400)}`)
    })
    // A stream whose pipe closes under it (the process exiting while a write or read is in flight)
    // emits 'error' on that stream alone. With zero listeners Node treats that as unhandled and
    // throws, crashing the whole Host over one line process's ordinary teardown race — logged instead.
    child.stdin?.on('error', (err) => a.log(`proc pid ${child.pid ?? '?'} stdin: ${String(err)}`))
    child.stdout?.on('error', (err) => a.log(`proc pid ${child.pid ?? '?'} stdout: ${String(err)}`))
    child.stderr?.on('error', (err) => a.log(`proc pid ${child.pid ?? '?'} stderr: ${String(err)}`))
    // Node only guarantees stdio has been fully delivered at 'close', not 'exit' — this tail exists to
    // catch a process's *last* write, so a write racing 'exit' is the case it is for, not a corner
    // case to shrug off; losing that race means the line lands in the Host's own log (above) and
    // never on the screen it was supposed to reach. 'close' is the real trigger; 'exit' only arms a
    // short grace timer that reports the same end if 'close' still has not come — a grandchild that
    // inherited a pipe (or otherwise keeps one open) can make 'close' wait far longer than this, or
    // never fire at all, and a session must not go on reading as alive because of a process that is
    // not even this one's child any more.
    child.on('close', (code, signal) => end(code ?? (signal ? 1 : 0)))
    child.on('exit', (code, signal) => {
      exitTimer = setTimeout(() => end(code ?? (signal ? 1 : 0)), 150)
    })
    // ENOENT and its kind arrive here, asynchronously, with no pid — the registry sees a process that
    // started and ended at once with code 1 and a log line saying why.
    child.on('error', (err) => {
      a.log(`proc could not start ${file}: ${String(err)}`)
      end(1)
    })
    return {
      get pid() {
        return child.pid ?? 0
      },
      onData: (cb) => {
        onData = cb
      },
      onExit: (cb) => {
        onExit = cb
      },
      write: (data) => {
        if (ended) return
        child.stdin?.write(data)
      },
      kill: () => {
        if (ended) return
        if (a.platform === 'win32' && child.pid) {
          // The whole tree: `codex app-server` and `claude` both start children of their own.
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
        } else {
          // SIGTERM to the child itself — not its children; treeKillCommand's posix contract is the
          // same, and codex app-server's own children are its to clean up on SIGTERM.
          child.kill('SIGTERM')
        }
      }
    }
  }
}
