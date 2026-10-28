// The process tools the Linux and macOS desks and the leftover sweep share (Linux and macOS design,
// kill; R10): a process's start time read from the kernel's own record, the same way when a launch is
// recorded and when it is checked; a process group ended with SIGTERM, then SIGKILL after 2 s, and a
// whole process tree ended the same way, group by group; a detached spawn that makes the launched
// process a group leader; and a tool run to its end.
import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import type { Readable } from 'node:stream'
import { DESK_REQUEST_MS } from '../../core/workspace/protocol'

export const GROUP_KILL_GRACE_MS = 2_000
const GROUP_POLL_MS = 100
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Epoch ms from a /proc/<pid>/stat line: field 22 is clock ticks since boot, and btime is the boot
 *  time in seconds. The command name (field 2) may hold spaces and parentheses, so the fields are
 *  counted from the last ')' (Review Focus 2). */
export function procStartMs(stat: string, btimeSec: number, ticksPerSec: number): number | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  // The first field after the name is field 3, so field 22 is the 20th.
  const ticks = Number(stat.slice(close + 1).trim().split(/\s+/)[19])
  if (!Number.isFinite(ticks) || ticks < 0) return null
  return btimeSec * 1000 + Math.round((ticks * 1000) / ticksPerSec)
}

export function btimeOf(procStat: string): number | null {
  const m = /^btime\s+(\d+)\s*$/m.exec(procStat)
  return m ? Number(m[1]) : null
}

/** `ps -o lstart=` under LC_ALL=C: "Sat Sep  7 10:11:12 2026", local time, whole seconds. */
export function parseLstart(text: string): number | null {
  const m = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim())
  if (!m) return null
  const month = MONTHS.indexOf(m[1])
  if (month < 0) return null
  return new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime()
}

export type ExecText = (file: string, args: string[]) => Promise<string>

/** Runs a program to its end for its text, killed after `timeoutMs`; a failure carries its exit `code`
 *  and its `stdout`. */
export const execTextWithin =
  (timeoutMs: number): ExecText =>
  (file, args) =>
    new Promise((resolve, reject) => {
      execFile(file, args, { timeout: timeoutMs }, (err, stdout) => (err ? reject(Object.assign(err, { stdout: String(stdout) })) : resolve(String(stdout))))
    })

/** execTextWithin with the 30 s every tool gets unless it has a reason for less. */
export const execText: ExecText = execTextWithin(30_000)

export interface LinuxProcFs {
  readFile(p: string): Promise<string>
  ticksPerSec(): Promise<number>
}

export function realLinuxProcFs(exec: ExecText): LinuxProcFs {
  let hz: Promise<number> | null = null
  return {
    readFile: (p) => fs.readFile(p, 'utf8'),
    ticksPerSec: () =>
      (hz ??= exec('getconf', ['CLK_TCK']).then(
        (t) => {
          const n = Number(t.trim())
          return Number.isSafeInteger(n) && n > 0 ? n : 100
        },
        () => 100
      ))
  }
}

/** Each live pid's start time, epoch ms, from /proc. A pid with no stat file is gone and left out. */
export async function linuxStartTimes(pids: number[], d: LinuxProcFs): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (pids.length === 0) return out
  const btime = btimeOf(await d.readFile('/proc/stat'))
  if (btime === null) throw new Error('/proc/stat has no btime line')
  const hz = await d.ticksPerSec()
  await Promise.all(
    pids.map(async (pid) => {
      const line = await d.readFile(`/proc/${pid}/stat`).catch(() => null)
      const ms = line === null ? null : procStartMs(line, btime, hz)
      if (ms !== null) out.set(pid, ms)
    })
  )
  return out
}

/** Each live pid's start time, epoch ms, from one `ps` call. LC_ALL=C, so the month names are the
 *  ones parseLstart reads whatever the person's locale (Review Focus 5). ps exits 1 when one of the
 *  pids is gone, and still prints the rest, so only that code is swallowed; anything else (an ENOENT,
 *  a timeout, a signal) is rethrown, since silently answering an empty map here reads as "every pid is
 *  gone" to the leftover sweep and leaves those processes running forever (fix round 1). */
export async function macStartTimes(pids: number[], exec: ExecText): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (pids.length === 0) return out
  const text = await exec('env', ['LC_ALL=C', 'ps', '-o', 'pid=,lstart=', '-p', pids.join(',')]).catch((err: { code?: unknown; stdout?: unknown }) => {
    if (err?.code === 1) return String(err.stdout ?? '')
    throw err
  })
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!m) continue
    const ms = parseLstart(m[2])
    if (ms !== null) out.set(Number(m[1]), ms)
  }
  return out
}

export interface Signals {
  /** process.kill: throws with code ESRCH when nothing has that pid or group. */
  kill(pid: number, sig: NodeJS.Signals | 0): void
  sleep(ms: number): Promise<void>
}

export const realSignals: Signals = {
  kill: (pid, sig) => {
    process.kill(pid, sig)
  },
  sleep: (ms) =>
    new Promise((r) => {
      const t = setTimeout(r, ms)
      // Unref'd: a grace poll in progress must never be the reason the Host's own process stays up.
      t.unref?.()
    })
}

const isGone = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 'ESRCH'

/** Ends pid's process group (a detached launch made it the leader), or pid alone when it leads none:
 *  SIGTERM, a poll every 100 ms, and SIGKILL once `graceMs` has passed. A group already gone is not a
 *  failure. Never pid 0 or 1, and never a negative number: those would reach the Host's own group or
 *  every process the user owns (Review Focus 3).
 *
 *  Not `endChild` (scriptWorker.ts): that one kills a live `ChildProcess` it still owns, synchronously,
 *  with SIGKILL at once and no grace, because the script child must die now (P14). This one gets only
 *  a recorded pid, possibly after a Host restart, and follows the spec's grace period instead. */
export async function killGroup(pid: number, s: Signals = realSignals, graceMs: number = GROUP_KILL_GRACE_MS): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`not a pid: ${pid}`)
  let target = -pid
  try {
    s.kill(target, 'SIGTERM')
  } catch (err) {
    if (!isGone(err)) throw err
    target = pid
    try {
      s.kill(target, 'SIGTERM')
    } catch (again) {
      if (isGone(again)) return
      throw again
    }
  }
  const alive = (): boolean => {
    try {
      s.kill(target, 0)
      return true
    } catch (err) {
      if (isGone(err)) return false
      throw err
    }
  }
  for (let waited = 0; waited < graceMs; waited += GROUP_POLL_MS) {
    await s.sleep(GROUP_POLL_MS)
    if (!alive()) return
  }
  try {
    s.kill(target, 'SIGKILL')
  } catch (err) {
    if (!isGone(err)) throw err
  }
}

export interface ProcRow {
  pid: number
  ppid: number
  pgid: number
}

/** The whole process table, run through `env`, one row per process and no header. Under LC_ALL=C as
 *  every ps here is. -A and the pid, ppid and pgid keywords are in both procps's ps(1) and the BSD one
 *  macOS ships, and both take one -o per keyword and print no header line when every header is empty
 *  (`=`); one -o each, so no `=` is ever read as the start of a header that runs on to the next. */
export const PS_TREE_ARGS = ['LC_ALL=C', 'ps', '-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=']

/** `ps -o pid= -o ppid= -o pgid=` lines; anything else (a header, noise) is skipped. */
export function parsePsTree(text: string): ProcRow[] {
  const out: ProcRow[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]) })
  }
  return out
}

/** What ending `root` and everything it started signals, from one snapshot of the process table:
 *  every group led by the root or by a process in its tree, and by its pid alone each process in the
 *  tree whose group is led from outside it. The tree is the root, every process whose parent is in
 *  it, and every member of a group a process in it leads (so the root's group is still found when the
 *  root itself is gone). A child started detached calls setsid (libuv, src/unix/process.c), so its
 *  group is not the root's: that is what the root's group kill alone left running.
 *
 *  A detached child whose parent exited before the snapshot cannot be found: the kernel gave it a new
 *  parent, and its group and session are its own, so nothing in the table leads to it.
 *
 *  Never pid 0 or 1, the Host's own pid, or a group any of them or the Host's own group leads: those
 *  would reach the kernel, init, or the Host and every session it holds. The Host's pid is never
 *  walked through either, so a root above the Host never reaches what the Host started. */
export function treeKillTargets(rows: readonly ProcRow[], root: number, hostPid: number): { groups: number[]; pids: number[] } {
  if (root <= 1 || root === hostPid) return { groups: [], pids: [] }
  const { groups, pids } = walkTree(rows, [root], hostPid)
  return { groups, pids }
}

/** What a second listing, taken once the grace has passed and before SIGKILL, adds to the first
 *  (`before`): what a process of the first tree that is still alive started since, by parent or by a
 *  group it leads (a dev app that outlived its SIGTERM and started its Host again), and the group of
 *  one that has left its group since. Nothing the first listing already targets, and the same guards
 *  as treeKillTargets. What a process of the tree started and then left behind by exiting is an
 *  orphan by now and cannot be found, as in the first listing. */
export function lateTreeTargets(before: readonly ProcRow[], after: readonly ProcRow[], root: number, hostPid: number): { groups: number[]; pids: number[] } {
  if (root <= 1 || root === hostPid) return { groups: [], pids: [] }
  const first = walkTree(before, [root], hostPid)
  const now = new Set(after.map((r) => r.pid))
  // A group the first listing targets still covers its members when its leader has gone since.
  const late = walkTree(after, [...first.tree].filter((p) => now.has(p)), hostPid, first.groups)
  const had = new Set([...first.groups.map((g) => -g), ...first.pids])
  return { groups: late.groups.filter((g) => !had.has(-g)), pids: late.pids.filter((p) => !had.has(p)) }
}

/** The tree from `seeds` in one listing, and its targets (treeKillTargets). A process in one of
 *  `ended` (groups already being ended) is not a pid target of its own. */
function walkTree(
  rows: readonly ProcRow[],
  seeds: readonly number[],
  hostPid: number,
  ended: readonly number[] = []
): { tree: Set<number>; groups: number[]; pids: number[] } {
  const wall = (pid: number): boolean => pid <= 1 || pid === hostPid
  const hostPgid = rows.find((r) => r.pid === hostPid)?.pgid ?? hostPid
  const children = new Map<number, number[]>()
  const members = new Map<number, number[]>()
  const pgidOf = new Map<number, number>()
  for (const r of rows) {
    if (!children.has(r.ppid)) children.set(r.ppid, [])
    children.get(r.ppid)!.push(r.pid)
    if (!members.has(r.pgid)) members.set(r.pgid, [])
    members.get(r.pgid)!.push(r.pid)
    pgidOf.set(r.pid, r.pgid)
  }
  const tree = new Set<number>(seeds.filter((p) => !wall(p)))
  for (const queue = [...tree]; queue.length > 0; ) {
    const p = queue.pop()!
    for (const next of [...(children.get(p) ?? []), ...(members.get(p) ?? [])]) {
      if (wall(next) || tree.has(next)) continue
      tree.add(next)
      queue.push(next)
    }
  }
  const groups = [...tree].filter((p) => members.has(p) && p !== hostPgid).sort((a, b) => a - b)
  const led = new Set([...groups, ...ended])
  // A pid missing from the listing (only the root can be) is gone: signalling it could only reach
  // whoever got the number since.
  const pids = [...tree].filter((p) => pgidOf.has(p) && !led.has(pgidOf.get(p)!)).sort((a, b) => a - b)
  return { tree, groups, pids }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Ends `pid` and everything it started (treeKillTargets), from a ps listing taken before any
 *  signal: SIGTERM to each target, a poll every 100 ms, and SIGKILL to what is left once `graceMs`
 *  has passed, as killGroup does for one group. When something outlives the grace, the table is listed
 *  once more before SIGKILL, and what a process of the tree still alive started meanwhile is killed
 *  with it (lateTreeTargets); a detached child whose parent exited during the grace is an orphan by
 *  then and is missed. A target already gone is not a failure; one that may not be signalled does not
 *  stop the rest, and its error is thrown once the others are done. When the first listing fails, the
 *  root's own group is still ended (killGroup), and then the failure is thrown. */
export async function killProcessTree(
  pid: number,
  o: { exec?: ExecText; signals?: Signals; graceMs?: number; hostPid?: number } = {}
): Promise<void> {
  const s = o.signals ?? realSignals
  const graceMs = o.graceMs ?? GROUP_KILL_GRACE_MS
  const hostPid = o.hostPid ?? process.pid
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`not a pid: ${pid}`)
  if (pid === hostPid) throw new Error(`not a pid to end: ${pid} is this Host's own`)
  const exec = o.exec ?? execText
  let rows: ProcRow[]
  try {
    rows = parsePsTree(await exec('env', PS_TREE_ARGS))
  } catch (err) {
    await killGroup(pid, s, graceMs)
    throw new Error(`pid ${pid}: its process group was ended, but the rest of its tree could not be listed: ${messageOf(err)}`)
  }
  const t = treeKillTargets(rows, pid, hostPid)
  const failures: unknown[] = []
  /** False when the target is gone, or may not be signalled (kept for the throw at the end). */
  const send = (target: number, sig: NodeJS.Signals | 0): boolean => {
    try {
      s.kill(target, sig)
      return true
    } catch (err) {
      if (!isGone(err)) failures.push(err)
      return false
    }
  }
  let live = [...t.groups.map((g) => -g), ...t.pids].filter((target) => send(target, 'SIGTERM'))
  for (let waited = 0; live.length > 0 && waited < graceMs; waited += GROUP_POLL_MS) {
    await s.sleep(GROUP_POLL_MS)
    live = live.filter((target) => send(target, 0))
  }
  if (live.length > 0) {
    // The grace is over, so what turns up now gets SIGKILL with the rest, no SIGTERM first.
    try {
      const late = lateTreeTargets(rows, parsePsTree(await exec('env', PS_TREE_ARGS)), pid, hostPid)
      live.push(...late.groups.map((g) => -g), ...late.pids)
    } catch (err) {
      failures.push(new Error(`pid ${pid}: its tree could not be listed again before SIGKILL: ${messageOf(err)}`))
    }
  }
  for (const target of live) send(target, 'SIGKILL')
  if (failures.length > 0) throw failures[0]
}

export interface SpawnedProc {
  readonly pid: number | undefined
  /** Once, however it ended: an exit, a signal, a failed start. A listener added after the end is
   *  called at once. */
  onExit(cb: (why: string) => void): void
  /** The last of its stderr, one line, when it was spawned with `stderr: true`. */
  stderrTail(): string
  /** What it wrote to fd 3 so far, when it was spawned with `readyFd: true` (Xvfb's -displayfd). */
  readyText?(): string
  kill(sig?: NodeJS.Signals): void
}

export type SpawnDetached = (file: string, args: string[], o: { env: Record<string, string>; cwd?: string; stderr?: boolean; readyFd?: boolean }) => SpawnedProc

/** A process in a new process group (so the group can be ended as one), stdin and stdout ignored,
 *  and not holding the Host's event loop open. */
export const spawnDetached: SpawnDetached = (file, args, o) => {
  const child = spawn(file, args, {
    env: o.env,
    cwd: o.cwd,
    detached: true,
    stdio: ['ignore', 'ignore', o.stderr ? 'pipe' : 'ignore', ...(o.readyFd ? (['pipe'] as const) : [])]
  })
  const cbs: Array<(why: string) => void> = []
  let tail = ''
  let ready = ''
  let ended: string | null = null
  const end = (why: string): void => {
    if (ended !== null) return
    ended = why
    for (const cb of cbs) cb(why)
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8')
    // Read to the end: a process whose stderr pipe closes dies of SIGPIPE on its next write.
    child.stderr.on('data', (c: string) => {
      tail = (tail + c).slice(-2_000)
    })
    // R3: a broken pipe here is not this call's failure; 'close' still judges the exit either way.
    child.stderr.on('error', () => {})
    ;(child.stderr as unknown as { unref?(): void }).unref?.()
  }
  const fd3 = o.readyFd ? (child.stdio[3] as Readable | null) : null
  if (fd3) {
    fd3.setEncoding('utf8')
    fd3.on('data', (c: string) => {
      ready = (ready + c).slice(-200)
    })
    // R3, as for stderr.
    fd3.on('error', () => {})
    ;(fd3 as unknown as { unref?(): void }).unref?.()
  }
  // R3: a spawn that fails emits 'error', which is an exit here, never an unhandled event.
  child.on('error', (err) => end(`${file} could not start: ${err.message}`))
  // 'close', not 'exit': close comes once stdio has fully closed too, so stderrTail() has read
  // everything the process wrote by the time onExit fires (the same ordering as endChild's judge in
  // scriptWorker.ts, 37c31855).
  child.on('close', (code, signal) => end(`exited ${String(signal ?? code)}`))
  child.unref()
  return {
    get pid() {
      return child.pid
    },
    onExit: (cb) => {
      if (ended !== null) cb(ended)
      else cbs.push(cb)
    },
    stderrTail: () => tail.trim().replace(/\s+/g, ' '),
    readyText: () => ready,
    kill: (sig = 'SIGTERM') => {
      if (ended !== null) return
      try {
        child.kill(sig)
      } catch {
        /* already gone; the exit reports it */
      }
    }
  }
}

export type RunTool = (file: string, args: string[], env: Record<string, string>) => Promise<Buffer>

/** Runs a desk tool (xdotool, import) to its end for its stdout bytes, within the desk request limit.
 *  A failure carries its exit `code` and its `stderr`. */
export const runTool: RunTool = (file, args, env) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: DESK_REQUEST_MS }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr).trim() }))
      else resolve(stdout)
    })
  })
