// The app half of S6 R14: a coordinator's slot is released only after the same roll window every other
// exit subscriber waits (EXIT_DEFER_MS), so a roll's rekey of the slot lands first.
import { EXIT_DEFER_MS } from '../../core/orchestration/exec/exitOwner'

export function deferCoordinatorRelease(
  release: (sessionId: string, exitCode: number) => Promise<void>,
  e: { sessionId: string; exitCode: number },
  log: (m: string) => void = () => {}
): void {
  setTimeout(() => {
    void release(e.sessionId, e.exitCode).catch((err) => log(`coordinator release failed session=${e.sessionId}: ${String(err)}`))
  }, EXIT_DEFER_MS)
}
