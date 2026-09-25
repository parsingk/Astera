import {
  HOST_FEATURE_BLOCKS,
  HOST_FEATURE_CHAT_TAKEOVER,
  HOST_FEATURE_COORDINATOR_IDLE,
  HOST_FEATURE_DISPATCH,
  HOST_FEATURE_ROLLING,
  HOST_FEATURE_ROLL_JOURNAL,
  HOST_FEATURE_SPAWN,
  HOST_FEATURE_WORKTREES
} from '../core/host/protocol'

/** R5, R7 (S3, S4) and R17 (S6): a Host that starts sessions also owns worktrees.json, drives Jobs and
 *  rolls its sessions. One fact, one list. `blocks` (S6 D4) is the rolling's block registry, so it
 *  rides the same fact, and so does `roll-journal` (S6 limits D5), the journal of the rolls no app saw,
 *  and so does `chat-takeover`, the rolling of an app's chat sessions once that app is gone. */
export function hostFeatures(a: { spawns: boolean }): string[] {
  const spawning = a.spawns ? [HOST_FEATURE_SPAWN, HOST_FEATURE_WORKTREES, HOST_FEATURE_DISPATCH, HOST_FEATURE_ROLLING, HOST_FEATURE_BLOCKS, HOST_FEATURE_ROLL_JOURNAL, HOST_FEATURE_CHAT_TAKEOVER] : []
  // `coordinator-idle` (final round 3) does not ride that fact: every Host serves the CLI's
  // `check --wait`, spawner or not, and it is exactly the Host an app drives in front of that is asked.
  return [...spawning, HOST_FEATURE_COORDINATOR_IDLE]
}
