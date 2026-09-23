// The Host's half of exit handling (Host S2 design §2.6, plan rulings R2 and R3).
//
// Each pty has one owner (`core/orchestration/exec/exitOwner.ts`). The app owns every pty an app
// socket has `pty-spawn`ed or `pty-attach`ed, and handles its exit through its own roll tap. The Host
// owns every other agent session, which are the ones its spawner started for a CLI call, and handles
// their exits here, after the same defer the app uses.
//
// **The handover.** An app that quits inside its own defer never handles the exits that landed in
// that window, and nobody else would: the Host saw them, but they were the app's. So when an app
// socket goes, the Host waits out the same defer and then closes every Dispatch and coordinator slot
// whose session its registry holds as ended. A session the registry never held is skipped (R3): its
// exit code is unknown here, and the next `store.load` is the conservative place for it.
//
// **Keyed by socket number, not by role.** A socket's role comes from its `hello`, and a second
// `hello` can change it (review M3 of Tasks 6 to 8), so the marks are released by the socket that
// made them whatever it calls itself now.
import { EXIT_DEFER_MS, hostOwnsExit } from '../core/orchestration/exec/exitOwner'
import type { PtyRegistry } from './registry'

/** The code handed on for a pty that ended with no code (node-pty can deliver one). The session did
 *  end, so its Dispatch closes; and it reads as a failure, because nothing said it succeeded. **Not
 *  -1**: that is `PTY_LOST_SIGHT_EXIT_CODE`, which `handleExit` reads as "still running" and keeps
 *  the Dispatch open over. */
export const ENDED_WITHOUT_A_CODE = -2

export interface HostExitsDeps {
  registry: Pick<PtyRegistry, 'onExit' | 'metaOf' | 'sessionPty' | 'sessionExitCode'>
  sessionExited(e: { sessionId: string; exitCode: number }): Promise<void>
  orphanedSessions(isAlive: (sessionId: string) => boolean): string[]
  log(m: string): void
  /** Test injection; the wiring leaves it out and gets EXIT_DEFER_MS. */
  deferMs?: number
}

export interface HostExits {
  /** An app socket spawned or attached this pty, so its exit is that app's. */
  heldBy(ptyId: string, socket: number): void
  /** A socket closed: its marks go, and if it ever held a pty the handover runs after the defer. */
  appGone(socket: number): void
}

export function createHostExits(d: HostExitsDeps): HostExits {
  const deferMs = d.deferMs ?? EXIT_DEFER_MS
  /** Which app sockets hold each pty. A set, because an app reconnecting can attach a pty on its new
   *  socket before the close of its old one arrives, and that close must not release the new hold. */
  const holders = new Map<string, Set<number>>()
  /** The sockets that have held a pty at any time. A held pty's mark goes when it exits, so by the
   *  time its socket closes the marks can be empty in exactly the case the handover is for. And a
   *  socket that never held one, which is every CLI call, had no exit to hand over, so it runs no
   *  sweep: the CLI connects once per command. */
  const everHeld = new Set<number>()

  /** Runs `work` after the defer. **Everything it throws or rejects stays here**: a timer callback
   *  runs outside any caller's try/catch, so a throw would reach the event loop and end the Host with
   *  every pty it holds. The async wrapper turns a synchronous throw into a rejection, and the one
   *  catch logs both. */
  const later = (what: string, work: () => Promise<void>): void => {
    setTimeout(() => {
      void (async () => work())().catch((err) => d.log(`${what} failed: ${String(err)}`))
    }, deferMs)
  }

  const codeOf = (code: number | null | undefined): number => (typeof code === 'number' ? code : ENDED_WITHOUT_A_CODE)

  d.registry.onExit((ptyId, exitCode) => {
    const held = holders.has(ptyId)
    // The mark goes with the pty: a dead pty cannot be held again.
    holders.delete(ptyId)
    const meta = d.registry.metaOf(ptyId)
    if (!meta || !hostOwnsExit({ kind: meta.kind, heldByApp: held })) return
    const sessionId = meta.id
    // Typed a number, but node-pty can deliver nothing; see ENDED_WITHOUT_A_CODE.
    const code = codeOf(exitCode)
    later(`handling the exit of session ${sessionId}`, () => d.sessionExited({ sessionId, exitCode: code }))
  })

  return {
    heldBy(ptyId, socket) {
      const set = holders.get(ptyId) ?? new Set<number>()
      set.add(socket)
      holders.set(ptyId, set)
      everHeld.add(socket)
    },
    appGone(socket) {
      for (const [ptyId, set] of holders) {
        set.delete(socket)
        if (set.size === 0) holders.delete(ptyId)
      }
      if (!everHeld.delete(socket)) return
      // **Whether or not an app has attached again in the meantime.** Only ended sessions are closed
      // here, a dead session cannot be held again, and the new app never hears an exit that happened
      // before it attached. Overlap with an app that did handle one is harmless: `handleExit` on a
      // Dispatch that is already closed does nothing (§8.2 step 5).
      later('the handover sweep', async () => {
        for (const sessionId of d.orphanedSessions((s) => d.registry.sessionPty(s) !== null)) {
          const ended = d.registry.sessionExitCode(sessionId)
          if (!ended) {
            d.log(`handover: session ${sessionId} was never in this Host's registry — left for the next load`)
            continue
          }
          d.log(`handover: session ${sessionId} ended (${ended.code ?? 'no code'}) — handling its exit`)
          // One at a time, and one failure does not stop the rest.
          await (async () => d.sessionExited({ sessionId, exitCode: codeOf(ended.code) }))().catch((err) =>
            d.log(`handling the exit of session ${sessionId} failed: ${String(err)}`)
          )
        }
      })
    }
  }
}
