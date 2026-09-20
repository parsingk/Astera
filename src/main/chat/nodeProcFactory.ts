// A line process as the app's own child — the ProcFactory used when there is no Host (dev mode, or a
// Host that is down). It dies with the app, and the session built on it says so (chat-sessions design
// §6.5). Lines are split by the same splitter the Host uses.
import { spawn } from 'node:child_process'
import { createLineSplitter } from '../../core/host/lines'
import { treeKillCommand } from '../../core/run/kill'
import type { ProcFactory, ProcLike } from '../../core/sessions/proc'
import { createStderrTail } from '../../core/sessions/stderrTail'

export const nodeProcFactory: ProcFactory = (file, args, opts): ProcLike => {
  const child = spawn(file, args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let onLine: (line: string) => void = () => {}
  let onExit: (e: { exitCode: number; stderrTail?: string }) => void = () => {}
  let ended = false
  const splitter = createLineSplitter((line) => onLine(line))
  const tail = createStderrTail()
  const end = (code: number): void => {
    if (ended) return
    ended = true
    splitter.flush()
    onExit({ exitCode: code, ...(tail.value() !== undefined ? { stderrTail: tail.value() } : {}) })
  }
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (c: string) => splitter.push(c))
  child.stderr?.setEncoding('utf8')
  // Still drained — a child blocked on stderr was the original reason this line existed — but the last
  // 4000 characters are kept now. When the CLI dies at birth this is the only account of why, and the
  // chat pane had none (design D1).
  child.stderr?.on('data', (c: string) => tail.push(c))
  child.on('exit', (code, signal) => end(code ?? (signal ? 1 : 0)))
  child.on('error', () => end(1))
  // A stream failing under a write or read is the child going away; `exit`/`error` on the child
  // already report that — these must not throw.
  child.stdin?.on('error', () => {})
  child.stdout?.on('error', () => {})
  child.stderr?.on('error', () => {})
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
      // where the caller falls back to SIGTERM to the child itself — not its children; treeKillCommand's
      // posix contract is the same, and codex app-server's own children are its to clean up on SIGTERM.
      const k = treeKillCommand(process.platform, child.pid)
      if (k === null) child.kill('SIGTERM')
      else spawn(k.file, k.args, { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
    }
  }
}
