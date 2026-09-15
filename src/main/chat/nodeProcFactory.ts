// A line process as the app's own child — the ProcFactory used when there is no Host (dev mode, or a
// Host that is down). It dies with the app, and the session built on it says so (chat-sessions design
// §6.5). Lines are split by the same splitter the Host uses.
import { spawn } from 'node:child_process'
import { createLineSplitter } from '../../core/host/lines'
import { treeKillCommand } from '../../core/run/kill'
import type { ProcFactory, ProcLike } from '../../core/sessions/proc'

export const nodeProcFactory: ProcFactory = (file, args, opts): ProcLike => {
  const child = spawn(file, args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let onLine: (line: string) => void = () => {}
  let onExit: (e: { exitCode: number }) => void = () => {}
  let ended = false
  const splitter = createLineSplitter((line) => onLine(line))
  const end = (code: number): void => {
    if (ended) return
    ended = true
    splitter.flush()
    onExit({ exitCode: code })
  }
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (c: string) => splitter.push(c))
  child.stderr?.resume() // not protocol; drained so the child cannot block on it
  child.on('exit', (code, signal) => end(code ?? (signal ? 1 : 0)))
  child.on('error', () => end(1))
  return {
    get pid() {
      return child.pid ?? 0
    },
    onLine: (cb) => {
      onLine = cb
    },
    onExit: (cb) => {
      onExit = cb
    },
    write: (line) => {
      if (!ended) child.stdin?.write(`${line}\n`)
    },
    kill: () => {
      if (ended || !child.pid) return
      // treeKillCommand(platform, pid) — pid then platform, as the brief first had it, is not this
      // function's real parameter order (src/core/run/kill.ts). It does still return null on posix,
      // where the caller ends the process group with an ordinary signal instead.
      const k = treeKillCommand(process.platform, child.pid)
      if (k === null) child.kill('SIGTERM')
      else spawn(k.file, k.args, { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
    }
  }
}
