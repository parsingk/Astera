// The console hosts node-pty leaves behind on Windows (leftovers Task 5, S3-2).
//
// node-pty 1.1.0 leaks one conhost.exe (OpenConsole.exe with its bundled ConPTY) for every pty that
// ends by itself: its native exit thread never calls ClosePseudoConsole, so the pseudoconsole's host
// process stays a child of the Host for as long as the Host lives. Measured on Windows 11 (2026-09-26):
// after `cmd /c exit 0` in a pty the conhost.exe is still there seconds later, and killing it costs the
// parent and its next pty nothing. A Host lives for days and a Job starts many workers, so they pile up.
//
// The mitigation: once the Host holds no live pty, the console hosts that are its own children are
// all leftovers, and they are reaped. Everything that touches a real process arrives as a dependency.
import { execFile } from 'node:child_process'

/** How long after the last live pty ends before the reap runs. Long enough that a pty that ended is
 *  done draining and that a worker respawned right after its exit cancels the reap. */
export const CONHOST_REAP_DEBOUNCE_MS = 10_000

/** The console host image names, as `reapWindowsConsoleHosts`'s pipeline matches them. */
const CONSOLE_HOST = /^(conhost|openconsole)\.exe$/i

/** What one reap asks for: the console hosts that are `parentPid`'s own children, made inside
 *  `[createdFrom, createdTo]` (ms since the epoch). */
export interface ConhostReapQuery {
  parentPid: number
  createdFrom: number
  createdTo: number
}

/** One console host the reap found and tried to end: `error` when ending it failed. */
export interface ConhostReapResult {
  pid: number
  /** The image name, such as `conhost.exe`. */
  name: string
  error?: string
}

export interface ConhostReaper {
  /** A pty spawn has just returned. Cancels an armed reap and moves the "created after" bound. */
  spawned(): void
  /** A pty has exited. Arms the reap (debounced) when no pty is live any more. */
  exited(): void
  dispose(): void
}

export function createConhostReaper(d: {
  platform: NodeJS.Platform
  /** The Host's own pid: only its children are ever looked at, and only they are killed. */
  hostPid: number
  livePtys(): number
  /** Finds and ends, in one step, the console hosts the query names (`reapWindowsConsoleHosts`). One
   *  step so the pid it checked is the pid it ends (final review M3): listing and killing apart left
   *  a gap in which Windows could hand a listed pid to another process. */
  reapChildren(q: ConhostReapQuery): Promise<ConhostReapResult[]>
  log(m: string): void
  now?(): number
  after?(ms: number, fn: () => void): () => void
  debounceMs?: number
}): ConhostReaper {
  const now = d.now ?? Date.now
  const after =
    d.after ??
    ((ms: number, fn: () => void): (() => void) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return () => clearTimeout(t)
    })
  /** **The lower bound.** A console host made before this point is not a pty's: it is the Host's own,
   *  when the Host runs as a console program (a dev run under node.exe), and killing it would end the
   *  Host. Every pty spawn comes after this, so every leaked console host was made after it. */
  const startedAt = now()
  /** **The upper bound**: when the last pty spawn returned, or null before the first. A console host
   *  made after it belongs to a spawn that came later than anything this reap knows ended. */
  let lastSpawnAt: number | null = null
  let cancel: (() => void) | null = null
  let running = false
  let disposed = false

  const disarm = (): void => {
    cancel?.()
    cancel = null
  }

  const reap = async (): Promise<void> => {
    if (disposed || running) return
    running = true
    try {
      // Checked before the reap: a pty that is live has a live console host. One spawned while the reap
      // runs is past the upper bound, which is read here, before it.
      if (disposed || d.livePtys() !== 0) return
      const bound = lastSpawnAt
      if (bound === null) return
      // **Ending a leaked console host also ends whatever is still attached to it** (final review M1):
      // a process a worker left behind (a dev server it started) that still holds the pseudoconsole
      // goes with it. That is what ClosePseudoConsole does when node-pty does call it, so the reap
      // does no more than a pty that ended the ordinary way would have.
      let results: ConhostReapResult[]
      try {
        results = await d.reapChildren({ parentPid: d.hostPid, createdFrom: startedAt, createdTo: bound })
      } catch (err) {
        d.log(`conhost reap: the Host's console hosts could not be reaped: ${String(err)}`)
        return
      }
      for (const r of results) if (r.error !== undefined) d.log(`conhost reap: ${r.name} ${r.pid} could not be ended: ${r.error}`)
      const reaped = results.filter((r) => r.error === undefined).length
      if (results.length > 0) d.log(`conhost reap: no pty is live, reaped ${reaped} console host(s) node-pty left behind`)
    } finally {
      running = false
    }
  }

  return {
    spawned: () => {
      lastSpawnAt = now()
      disarm()
    },
    exited: () => {
      if (d.platform !== 'win32' || disposed || lastSpawnAt === null) return
      if (d.livePtys() !== 0) return
      disarm()
      cancel = after(d.debounceMs ?? CONHOST_REAP_DEBOUNCE_MS, () => {
        cancel = null
        // Never rejects (every step above catches), and the catch is the net under that (R3).
        reap().catch((err) => d.log(`conhost reap failed: ${String(err)}`))
      })
    },
    dispose: () => {
      disposed = true
      disarm()
    }
  }
}

type Exec = (file: string, args: string[]) => Promise<string>

const defaultExec: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 30_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
  })

/** Ends the console hosts `q` names, through Windows PowerShell, which every Windows 11 has (wmic is
 *  optional there and being removed). **One pipeline finds and ends them** (final review M3):
 *  `Win32_Process` filtered by parent, then `Where-Object` on the parent again, the image name and the
 *  creation window, then `Stop-Process` on each, so no pid can change hands between the check and the
 *  kill the way it could across two spawns. One line per match: `ok|pid|name` or `fail|pid|name|why`. */
export async function reapWindowsConsoleHosts(q: ConhostReapQuery, exec: Exec = defaultExec): Promise<ConhostReapResult[]> {
  const { parentPid, createdFrom, createdTo } = q
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error(`not a pid: ${parentPid}`)
  if (!Number.isSafeInteger(createdFrom) || !Number.isSafeInteger(createdTo)) throw new Error(`not a time window: ${createdFrom}..${createdTo}`)
  const script =
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" | Where-Object { ` +
    `$_.ParentProcessId -eq ${parentPid} -and $_.Name -match '^(conhost|openconsole)\\.exe$' -and ` +
    `([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() -ge ${createdFrom} -and ` +
    `([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() -le ${createdTo} } | ForEach-Object { ` +
    `$p = $_; try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; 'ok|{0}|{1}' -f $p.ProcessId, $p.Name } ` +
    `catch { 'fail|{0}|{1}|{2}' -f $p.ProcessId, $p.Name, ($_.Exception.Message -replace '[\\r\\n|]', ' ') } }`
  const out = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  const results: ConhostReapResult[] = []
  for (const line of out.split(/\r?\n/)) {
    const [status, pid, name, ...why] = line.trim().split('|')
    const n = Number(pid)
    if ((status !== 'ok' && status !== 'fail') || !Number.isSafeInteger(n) || n <= 0 || !name || !CONSOLE_HOST.test(name)) continue
    results.push(status === 'ok' ? { pid: n, name } : { pid: n, name, error: why.join('|') || 'unknown' })
  }
  return results
}
