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

export interface ConhostChild {
  pid: number
  parentPid: number
  /** The image name, such as `conhost.exe`. */
  name: string
  /** When the process was created, in ms since the epoch. */
  createdAt: number
}

const CONSOLE_HOST = /^(conhost|openconsole)\.exe$/i

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
  listChildren(parentPid: number): Promise<ConhostChild[]>
  kill(pid: number): void
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
      let rows: ConhostChild[]
      try {
        rows = await d.listChildren(d.hostPid)
      } catch (err) {
        d.log(`conhost reap: the Host's child processes could not be listed: ${String(err)}`)
        return
      }
      // Checked again after the listing: a pty spawned while it ran has a live console host in it.
      if (disposed || d.livePtys() !== 0) return
      const bound = lastSpawnAt
      if (bound === null) return
      const targets = rows.filter(
        (r) => r.parentPid === d.hostPid && CONSOLE_HOST.test(r.name) && r.createdAt >= startedAt && r.createdAt <= bound
      )
      let reaped = 0
      for (const t of targets) {
        try {
          d.kill(t.pid)
          reaped += 1
        } catch (err) {
          d.log(`conhost reap: ${t.name} ${t.pid} could not be ended: ${String(err)}`)
        }
      }
      if (targets.length > 0) d.log(`conhost reap: no pty is live, reaped ${reaped} console host(s) node-pty left behind`)
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

/** The children of `parentPid`, from `Win32_Process` through Windows PowerShell, which every Windows 11
 *  has (wmic is optional there and being removed). One line per child: `pid|parent|name|created ms`. */
export async function listWindowsChildren(parentPid: number, exec: Exec = defaultExec): Promise<ConhostChild[]> {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error(`not a pid: ${parentPid}`)
  const script =
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" | ForEach-Object { ` +
    `'{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }`
  const out = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  const rows: ConhostChild[] = []
  for (const line of out.split(/\r?\n/)) {
    const [pid, parent, name, created] = line.trim().split('|')
    const row = { pid: Number(pid), parentPid: Number(parent), name: name ?? '', createdAt: Number(created) }
    if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isSafeInteger(row.parentPid) || !Number.isFinite(row.createdAt) || row.name === '') continue
    rows.push(row)
  }
  return rows
}
