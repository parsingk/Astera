// The macOS Desk (Linux and macOS design, macOS Desk; L3): nothing to create. The app is launched in the
// person's own session, in the background and in a process group of its own, and driven only over
// CDP. windows(), windowShot() and keys() are refused: without the Screen Recording and Accessibility
// permissions (L3a, not built) nothing can see or type into another app's window, and this desk never
// moves one either (R5). So the app's window may sit behind the person's own (user decision L3b); the
// hide marker ASTERA_APP_CHROMIUM_FLAGS in its env lets a project app start with show:false. A plain
// command gets the Chromium switches that keep a page nobody sees rendering, in that variable for it
// to pass; an app bundle is opened with open -g -j -n (R6).
//
// Every process it touches arrives in `MacDeskDeps`, so the tests drive it on any OS; `realMacDeskDeps`
// is the real one.
import path from 'node:path'
import type { DeskHandle } from '../../core/workspace/helpers'
import { START_TIME_TOLERANCE_MS } from '../../core/workspace/lifecycle'
import { DESK_READY_MS, type DeskLaunched } from '../../core/workspace/protocol'
import { execText, execTextWithin, killProcessTree, macStartTimes, parseLstart, spawnDetached, type ExecText, type SpawnDetached } from './posixProc'

export const MAC_BACKGROUND_FLAGS =
  '--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling'
const POLL_MS = 200

/**
 * How long each ps of a bundle launch poll may take (stage 4 T6). A poll is two ps calls, and a failing
 * one is tried once more, so with execText's 30 s a hung ps held one poll for up to two minutes while the
 * launch said nothing. A healthy ps answers in milliseconds; five seconds is room to spare, and a ps
 * that runs out fails the launch with its reason instead.
 */
export const MAC_PS_TIMEOUT_MS = 5_000

export const macRefusal = (helper: 'windows' | 'windowShot' | 'keys'): string =>
  `${helper}: not available on macOS (the app runs in the background and only its page can be driven)`

/** A command whose first word is an app bundle (`/Applications/X.app`, quoted or not), and the rest. */
export function bundleCommand(command: string): { bundle: string; rest: string } | null {
  const m = /^\s*(?:"([^"]+?\.app)\/?"|'([^']+?\.app)\/?'|([^\s"']+?\.app)\/?)(\s[\s\S]*)?$/.exec(command)
  if (!m) return null
  return { bundle: m[1] ?? m[2] ?? m[3], rest: (m[4] ?? '').trim() }
}

/** Lists every process with its start time. `-ww`: without a tty ps cuts its columns short. */
export const BUNDLE_LIST_PS = ['-ww', '-Ao', 'pid=,lstart=']
/** Then the full argv of the few that started since the launch, their pids after these. */
export const BUNDLE_ARGS_PS = ['-ww', '-o', 'pid=,args=', '-p']

/** From `ps -Ao pid=,lstart=` under LC_ALL=C: each process that started at or after `sinceMs` (within
 *  the start time tolerance, since lstart has whole seconds), with that start time. */
export function recentStarts(psText: string, sinceMs: number): Map<number, number> {
  const out = new Map<number, number>()
  for (const line of psText.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const startedAt = parseLstart(m[2])
    if (startedAt !== null && startedAt >= sinceMs - START_TIME_TOLERANCE_MS) out.set(Number(m[1]), startedAt)
  }
  return out
}

/** Whether `tag` is one whole argument of a space joined argv. */
export function hasTag(args: string, tag: string): boolean {
  for (let i = args.indexOf(tag); i >= 0; i = args.indexOf(tag, i + 1)) {
    const before = i === 0 ? ' ' : args[i - 1]
    const after = args[i + tag.length] ?? ' '
    if (/\s/.test(before) && /\s/.test(after)) return true
  }
  return false
}

/** From `ps -o pid=,args=`: the earliest started process among `starts` whose argv carries `tag`, the
 *  lower pid on a tie, and never one of `exclude` (the opener, whose own argv carries the tag too). */
export function pickTagged(
  argsText: string,
  tag: string,
  starts: ReadonlyMap<number, number>,
  exclude: ReadonlySet<number>
): { pid: number; startedAt: number } | null {
  let best: { pid: number; startedAt: number } | null = null
  for (const line of argsText.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const startedAt = starts.get(pid)
    if (startedAt === undefined || exclude.has(pid) || !hasTag(m[2], tag)) continue
    if (!best || startedAt < best.startedAt || (startedAt === best.startedAt && pid < best.pid)) best = { pid, startedAt }
  }
  return best
}

export interface MacDeskDeps {
  spawn: SpawnDetached
  exec: ExecText
  /** A live pid's start time in epoch ms from ps, or null when it is gone. */
  startTime(pid: number): Promise<number | null>
  /** Ends a launched app and everything it started, a child it started detached included
   *  (killProcessTree, posixProc.ts). */
  killTree(pid: number): Promise<void>
  /** Resolves after ms, or at once when `signal` aborts (its timer cleared). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  now(): number
  log(m: string): void
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createMacDesks(d: MacDeskDeps): { start(name: string): Promise<DeskHandle> } {
  return {
    start: async (base) => {
      const name = `mac-bg-${base}`
      const launched = new Map<number, number>()
      let closed = false
      /** Numbers each bundle launch's tag. */
      let seq = 0
      // Aborted by close, so a bundle launch still polling stops at once and its timer is cleared.
      const stop = new AbortController()
      const closedError = (): Error => new Error('launch: this workspace is closed')

      const endQuietly = async (p: number): Promise<void> => {
        await d.killTree(p).catch((err: unknown) => d.log(`desktop ${name}: pid ${p} could not be ended: ${messageOf(err)}`))
      }

      const kill = async (p: number, at: number): Promise<void> => {
        const liveAt = await d.startTime(p)
        if (liveAt === null) {
          launched.delete(p)
          d.log(`desktop ${name}: pid ${p} is not running`)
          return
        }
        if (Math.abs(liveAt - at) > START_TIME_TOLERANCE_MS) {
          launched.delete(p)
          d.log(`desktop ${name}: start time mismatch: pid ${p} started at ${liveAt}, not ${at}; left alone`)
          return
        }
        await d.killTree(p)
        launched.delete(p)
      }

      /** The tagged app process of one bundle launch, from two ps calls: every process that started
       *  since the launch, then the argv of just those (a whole `ps -Ao args` on a Mac with many
       *  Chromium helpers could pass execFile's output limit). A failing ps is tried once more. */
      const findTagged = (tag: string, since: number, opener: number): Promise<{ pid: number; startedAt: number } | null> => {
        const once = async (): Promise<{ pid: number; startedAt: number } | null> => {
          const starts = recentStarts(await d.exec('env', ['LC_ALL=C', 'ps', ...BUNDLE_LIST_PS]), since)
          starts.delete(opener)
          if (starts.size === 0) return null
          // ps exits 1 when one of the pids is gone by now, and still prints the rest.
          const args = await d
            .exec('env', ['LC_ALL=C', 'ps', ...BUNDLE_ARGS_PS, [...starts.keys()].join(',')])
            .catch((err: { code?: unknown; stdout?: unknown }) => {
              if (err?.code === 1) return String(err.stdout ?? '')
              throw err
            })
          return pickTagged(args, tag, starts, new Set([opener]))
        }
        return once().catch(() => once())
      }

      const openBundle = async (b: { bundle: string; rest: string }, a: { cwd: string; env: Record<string, string> }): Promise<DeskLaunched> => {
        const bundle = path.posix.resolve(a.cwd, b.bundle)
        // A switch Chromium ignores, unique to this launch: the process that carries it is ours, not
        // the person's own instance, another desk's, or an earlier one of this desk's (fix round 1).
        const tag = `--astera-desk=${name}-${++seq}`
        // Only a lower bound for which processes to look at; the start time itself comes from ps.
        const since = d.now()
        // -g: not brought to the front; -j: launched hidden; -n: a new instance beside the person's.
        // The bundle is $0 and the tag $1, so neither needs quoting; the rest is the command's own
        // shell text. The tag comes first, before that text: a `#`, a `;` or a `--` in the rest would
        // otherwise cut it off, and the app would run with nothing to find it by (review I2). The flags
        // may be lost that way; they only make rendering better.
        const opener = d.spawn('sh', ['-c', `exec open -g -j -n -a "$0" --args "$1" ${b.rest} $ASTERA_APP_CHROMIUM_FLAGS`, bundle, tag], {
          env: { ...a.env, ASTERA_APP_CHROMIUM_FLAGS: MAC_BACKGROUND_FLAGS },
          cwd: a.cwd,
          stderr: true
        })
        if (opener.pid === undefined) throw new Error(`launch: sh could not start (${opener.stderrTail() || 'no reason given'})`)
        const openerPid = opener.pid
        const st = { opened: null as string | null }
        opener.onExit((why) => {
          st.opened = why
        })
        // open exits 0 once Launch Services has the request, before the app's process may show; any
        // other end means the app will not come, and waiting out the limit would hide why.
        const openFailed = (): boolean => st.opened !== null && st.opened !== 'exited 0'
        const until = since + DESK_READY_MS
        let why: Error
        for (;;) {
          if (closed) {
            why = closedError()
            break
          }
          // Before the limit: an open that failed in the same poll the limit passed says why (review M1).
          if (openFailed()) {
            const tail = opener.stderrTail()
            throw new Error(`launch: open could not start ${bundle} (${tail ? `${st.opened}: ${tail}` : st.opened})`)
          }
          if (d.now() >= until) {
            why = new Error(`launch: ${bundle} was opened, but no process of it appeared within ${DESK_READY_MS / 1000} s`)
            break
          }
          const hit = await findTagged(tag, since, openerPid).catch((err: unknown) => {
            throw new Error(`launch: ${bundle} was opened, but ps could not list its processes: ${messageOf(err)}`)
          })
          if (hit) {
            if (closed) {
              await endQuietly(hit.pid)
              throw closedError()
            }
            launched.set(hit.pid, hit.startedAt)
            return hit
          }
          await d.sleep(POLL_MS, stop.signal)
        }
        // Too late, or closed, yet the app may still be on its way: one bounded look more, never on the
        // aborted signal, so it is ended rather than left running unrecorded (fix round 1).
        for (const lateUntil = until + DESK_READY_MS; d.now() < lateUntil && !openFailed(); ) {
          const hit = await findTagged(tag, since, openerPid).catch(() => null)
          if (hit) {
            d.log(`desktop ${name}: pid ${hit.pid} of ${bundle} appeared after its launch gave up; ending it`)
            await endQuietly(hit.pid)
            break
          }
          await d.sleep(POLL_MS)
        }
        throw why
      }

      const launchCommand = async (a: { command: string; cwd: string; env: Record<string, string> }): Promise<DeskLaunched> => {
        // `wait` keeps sh, the group's leader, alive while anything the command put in the background
        // still runs, so the group always has a leader with a real start time to kill by. A newline,
        // not `;`, so a command ending in a comment still reaches it, and a blank line, so a command
        // ending in a backslash continues onto the empty line, not onto `wait` (review M3).
        const child = d.spawn('sh', ['-c', `${a.command}\n\nwait`], { env: { ...a.env, ASTERA_APP_CHROMIUM_FLAGS: MAC_BACKGROUND_FLAGS }, cwd: a.cwd })
        if (child.pid === undefined) throw new Error(`launch: sh could not start (${child.stderrTail() || 'no reason given'})`)
        const cpid = child.pid
        // From ps, never the clock: the leftover sweep compares this with the kernel's own record. When
        // the read itself fails the fresh group is ended here, since nothing else will know to.
        const at = await d.startTime(cpid).catch(async (err: unknown) => {
          await endQuietly(cpid)
          throw err
        })
        if (closed) {
          if (at !== null) await endQuietly(cpid)
          throw closedError()
        }
        if (at === null) {
          // Gone already (it exited at once): 0 matches no live process, so a later kill or sweep
          // never reaches a reused pid.
          d.log(`desktop ${name}: pid ${cpid} exited before its start time could be read; recorded with start time 0`)
          return { pid: cpid, startedAt: 0 }
        }
        launched.set(cpid, at)
        return { pid: cpid, startedAt: at }
      }

      return {
        name,
        pid: null,
        startedAt: 0,
        alive: () => !closed,
        // No helper process, so nothing ever ends by itself.
        onExit: () => {},
        launch: async (a): Promise<DeskLaunched> => {
          if (closed) throw closedError()
          const b = bundleCommand(a.command)
          return b ? openBundle(b, a) : launchCommand(a)
        },
        kill,
        windows: async () => {
          throw new Error(macRefusal('windows'))
        },
        shot: async () => {
          throw new Error(macRefusal('windowShot'))
        },
        keys: async () => {
          throw new Error(macRefusal('keys'))
        },
        close: async () => {
          closed = true
          stop.abort()
          for (const [p, at] of [...launched]) await kill(p, at).catch((err) => d.log(`desktop ${name}: pid ${p} could not be ended: ${messageOf(err)}`))
        }
      }
    }
  }
}

export function realMacDeskDeps(a: { log(m: string): void }): MacDeskDeps {
  return {
    spawn: spawnDetached,
    exec: execTextWithin(MAC_PS_TIMEOUT_MS),
    startTime: async (pid) => (await macStartTimes([pid], execText)).get(pid) ?? null,
    killTree: (pid) => killProcessTree(pid),
    sleep: (ms, signal) =>
      new Promise((r) => {
        if (signal?.aborted) return r()
        // One signal serves every poll of a desk, so each sleep takes its listener off again.
        const onAbort = (): void => {
          clearTimeout(t)
          r()
        }
        const t = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          r()
        }, ms)
        // Unref'd: a launch poll must never be the reason the Host's own process stays up.
        t.unref?.()
        signal?.addEventListener('abort', onAbort, { once: true })
      }),
    now: Date.now,
    log: a.log
  }
}
