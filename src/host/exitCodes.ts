// How the Host process ends, as a number a supervisor can act on (remote runtime design §2.9, Phase 0).
//
// Nothing reads these today: the app and the CLI start the Host detached, with its output ignored. They
// exist for `astera runtime serve`, which restarts a Host that failed and must not restart one that only
// lost the bind race to a Host already serving the profile. Until now both ended with 0.
import { ADDRESS_TAKEN } from './server'

export const HOST_EXIT = {
  /** Another Host already serves this profile: not a failure, it serves everyone. */
  lostBindRace: 0,
  /** The Host key could not be made, so no client would believe this Host (kept from before). */
  keyFailure: 2,
  /** Listening failed for any other reason. */
  listenFailed: 3,
  /** No profile folder was given. */
  noProfile: 4
} as const

export function listenExitCode(err: unknown): number {
  return err instanceof Error && err.message === ADDRESS_TAKEN ? HOST_EXIT.lostBindRace : HOST_EXIT.listenFailed
}
