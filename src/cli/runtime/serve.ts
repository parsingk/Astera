// `astera runtime serve` (remote runtime design §2.9, X1-13): the foreground supervisor an OS recipe runs so a Runtime
// keeps a Host while Remote is on. The rule is one sentence: a Host runs exactly while Remote is enabled. It never
// writes remote-runtime.json (enabling is `astera runtime start`, once), so an automatic restart can never re-enable a
// Remote the person turned off. When the app or an MCP client already started a Host, it watches that one instead of
// starting a second; the bind race decides between two starts, as it always has.
import type { RemoteSettings } from '../../core/remote/settings'

export interface ServeHostChild {
  /** Settles with the child's exit code (null when it was ended by a signal). */
  wait: Promise<number | null>
  kill(signal: 'SIGTERM'): void
}

export interface ServeDeps {
  settings(): Promise<RemoteSettings>
  /** Whether an update hold is valid now (core/remote/updateHold.ts). */
  hold(): boolean
  hostAnswers(): Promise<boolean>
  /** A Host in the foreground: a child of this process, not detached, logging to host.log; or why this machine's
   *  configuration cannot start one at all (no CLI paths), which no retry would change. */
  startHostChild(): ServeHostChild | { unusable: string }
  sleep(ms: number): Promise<void>
  /** Registers what SIGTERM and SIGINT do. */
  onSignal(fn: () => void): void
  now(): number
  log(message: string): void
}

export const SERVE_POLL_MS = 10_000
export const SERVE_BACKOFF_MS = [1_000, 2_000, 5_000]
export const SERVE_RETRY_MS = 30_000
const STABLE_MS = 30_000

/** What `serve` exits with (design §2.9): 0 after SIGTERM or SIGINT; 75 when an update began while it ran, so its
 *  supervisor starts it again on the new version; 78 for a configuration it cannot use. */
export const SERVE_EXIT = { stopped: 0, updated: 75, unusable: 78 } as const

/** Runs until SIGTERM or SIGINT (0), an update that begins while it runs (75), or a configuration it cannot use (78). */
export async function runServe(d: ServeDeps): Promise<number> {
  let stopping = false
  let child: ServeHostChild | null = null
  let failures = 0
  /** It has looked once with no update hold: a hold seen after that is an update that began while it ran. A serve
   *  started under a hold (an installer still at work) waits for it instead. */
  let ranFree = false
  d.onSignal(() => {
    stopping = true
    // Forwarded: the Host leaves the way it leaves on its own signal, ending its sessions' pipes cleanly.
    child?.kill('SIGTERM')
  })
  while (!stopping) {
    let s: RemoteSettings
    try {
      s = await d.settings()
    } catch (e) {
      d.log(`remote-runtime.json could not be read; starting nothing until it can: ${e instanceof Error ? e.message : String(e)}`)
      await d.sleep(SERVE_POLL_MS)
      continue
    }
    if (d.hold()) {
      if (ranFree) {
        // Leaving releases every file of this version, which the installer is about to replace (on Windows a running
        // program cannot be); the supervisor starts the new one, which waits out the rest of the hold.
        // Its Host is gone by now: the update path writes the hold and then retires the Host, and this look runs only between
        // children.
        d.log('an update began; leaving so the new version can start (exit 75)')
        return SERVE_EXIT.updated
      }
      await d.sleep(SERVE_POLL_MS)
      continue
    }
    ranFree = true
    if (!s.enabled) {
      await d.sleep(SERVE_POLL_MS)
      continue
    }
    if (await d.hostAnswers()) {
      await d.sleep(SERVE_POLL_MS)
      continue
    }
    if (stopping) break
    const startedAt = d.now()
    const started = d.startHostChild()
    if ('unusable' in started) {
      d.log(`no Host can start here: ${started.unusable} (exit 78)`)
      return SERVE_EXIT.unusable
    }
    child = started
    const code = await child.wait
    child = null
    if (stopping) break
    if (d.now() - startedAt >= STABLE_MS) failures = 0
    // 0: another Host won the bind race, so there is one to watch. Anything else is a crash or a start failure (exit
    // 3 for a listen failure, 4 for a missing profile; src/host/exitCodes.ts), and it backs off.
    // It waits all the same: a Host this CLI cannot handshake with (another protocol, a hung one) makes every child
    // leave with 0 at once, and that must not become a spawn loop.
    if (code === 0) {
      d.log('the Host left with 0 (another Host holds this profile address); looking again in 10 s')
      await d.sleep(SERVE_POLL_MS)
      continue
    }
    const wait = SERVE_BACKOFF_MS[failures++] ?? SERVE_RETRY_MS
    d.log(`the Host exited with ${code ?? 'a signal'}; starting another in ${wait / 1000} s`)
    await d.sleep(wait)
  }
  return SERVE_EXIT.stopped
}
