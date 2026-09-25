import { HOST_FEATURE_DISPATCH, HOST_FEATURE_ROLLING, HOST_FEATURE_SPAWN, HOST_FEATURE_WORKTREES } from '../core/host/protocol'

/** R5, R7 (S3, S4) and R17 (S6): a Host that starts sessions also owns worktrees.json, drives Jobs and
 *  rolls its sessions. One fact, one list. */
export function hostFeatures(a: { spawns: boolean }): string[] {
  return a.spawns ? [HOST_FEATURE_SPAWN, HOST_FEATURE_WORKTREES, HOST_FEATURE_DISPATCH, HOST_FEATURE_ROLLING] : []
}
