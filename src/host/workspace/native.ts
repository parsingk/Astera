// The process tools the workspace needs outside a desk: creation times for the leftover rule, a tree
// kill, and a free loopback port. On Windows, PowerShell and taskkill (the conhost reaper's route,
// src/host/conhostReaper.ts); on Linux and macOS, /proc or ps and a tree kill by process groups
// (posixProc.ts).
import { execFile } from 'node:child_process'
import net from 'node:net'
import { treeKillCommand } from '../../core/run/kill'
import { killProcessTree, linuxStartTimes, macStartTimes, realLinuxProcFs, realSignals, type LinuxProcFs, type Signals } from './posixProc'

export type Exec = (file: string, args: string[]) => Promise<string>

const defaultExec: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 30_000 }, (err, stdout) =>
      err ? reject(Object.assign(err, { stdout: String(stdout) })) : resolve(String(stdout))
    )
  })

let defaultLinuxProc: LinuxProcFs | null = null

async function windowsStartTimes(pids: number[], exec: Exec): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (pids.length === 0) return out
  const filter = pids.map((p) => `ProcessId=${p}`).join(' OR ')
  const script =
    `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { ` +
    `'{0}|{1}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }`
  const text = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  for (const line of text.split(/\r?\n/)) {
    const [pid, ms] = line.trim().split('|').map(Number)
    if (Number.isSafeInteger(pid) && pid > 0 && Number.isFinite(ms)) out.set(pid, ms)
  }
  return out
}

/** Each live pid's creation time in epoch ms. One query for all of them. The `platform === 'win32'`
 *  branch here and in `killTree` must agree on every other platform value (fix round 1): anything not
 *  win32 is POSIX, so both dispatch the same way, and only the start-time source further splits on
 *  darwin vs. linux (both use the same tree kill either way, killProcessTree in posixProc.ts). */
export async function processStartTimes(pids: number[], exec: Exec = defaultExec, platform: string = process.platform): Promise<Map<number, number>> {
  for (const p of pids) if (!Number.isSafeInteger(p) || p <= 0) throw new Error(`not a pid: ${p}`)
  return platform === 'win32'
    ? windowsStartTimes(pids, exec)
    : platform === 'darwin'
      ? macStartTimes(pids, exec)
      : linuxStartTimes(pids, exec === defaultExec ? (defaultLinuxProc ??= realLinuxProcFs(exec)) : realLinuxProcFs(exec))
}

async function windowsKillTree(pid: number, exec: Exec): Promise<void> {
  const cmd = treeKillCommand('win32', pid)
  if (!cmd) return
  await exec(cmd.file, cmd.args).catch((err: { code?: unknown }) => {
    if (err?.code === 128) return ''
    throw err
  })
}

/** Ends `pid` and every process it started. On Windows through taskkill, which answers 128 for a
 *  process already gone; elsewhere every process group it or a process it started leads, from a ps
 *  listing taken before any signal and again before SIGKILL (killProcessTree, R10), so a child started
 *  detached goes too. Gone is not a failure: the result the caller wanted is already true. */
export async function killTree(pid: number, exec: Exec = defaultExec, platform: string = process.platform, signals: Signals = realSignals): Promise<void> {
  // Not this file's 30 s exec off Windows: the tree kill's own listing has the desk request limit.
  return platform === 'win32' ? windowsKillTree(pid, exec) : killProcessTree(pid, { signals, ...(exec === defaultExec ? {} : { exec }) })
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}
