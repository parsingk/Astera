// A Host that is leaving refused to start a session.

/**
 * **What the Host's spawner throws once it has started to leave** (Host S2 design §8.4, R8, fix round
 * ruling a). A start taken after that moment would hand a worker to a registry that is about to kill
 * everything, so it is refused before it touches anything, and the command rolls back its Dispatch.
 *
 * **A type, beside `RepairNeeded`, and for the same reason.** The Host answers it as a conflict (409,
 * exit 6) carrying `retry: 'host-retiring'`, never as the 400 a failed start otherwise is: the caller's
 * arguments were fine, and the right move is the same command again once a Host is up. The CLI reads
 * the field, never the sentence, to offer that step (`STEPS.CONFLICT`).
 */
export class HostRetiring extends Error {
  /** The value of the 409's `retry` field. */
  static readonly RETRY = 'host-retiring'
  constructor() {
    super('the Host is retiring — start the worker again once a Host is up (astera host status shows when one is)')
  }
}
