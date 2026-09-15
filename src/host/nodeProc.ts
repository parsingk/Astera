// child_process behind RegistryProc — what the Host really spawns for a line process. The registry
// decides where lines end; this only delivers chunks, writes bytes, and reports the exit.
//
// Imports nothing outside core/host (the Host bundle rule), so the process-tree kill is written here
// rather than imported from core/run/kill.ts — the same two lines.
import { spawn } from 'node:child_process'
import type { ProcOpenOptions } from '../core/host/protocol'
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
    let onExit: (e: { exitCode: number }) => void = () => {}
    let ended = false
    const end = (code: number): void => {
      if (ended) return
      ended = true
      onExit({ exitCode: code })
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => onData(c))
    child.stderr?.setEncoding('utf8')
    // stderr is not protocol; it is the process complaining. The Host's log is where that belongs.
    child.stderr?.on('data', (c: string) => a.log(`proc pid ${child.pid ?? '?'} stderr: ${c.trim().slice(0, 400)}`))
    // A stream whose pipe closes under it (the process exiting while a write or read is in flight)
    // emits 'error' on that stream alone. With zero listeners Node treats that as unhandled and
    // throws, crashing the whole Host over one line process's ordinary teardown race — logged instead.
    child.stdin?.on('error', (err) => a.log(`proc pid ${child.pid ?? '?'} stdin: ${String(err)}`))
    child.stdout?.on('error', (err) => a.log(`proc pid ${child.pid ?? '?'} stdout: ${String(err)}`))
    child.stderr?.on('error', (err) => a.log(`proc pid ${child.pid ?? '?'} stderr: ${String(err)}`))
    child.on('exit', (code, signal) => end(code ?? (signal ? 1 : 0)))
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
