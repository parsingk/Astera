import path from 'node:path'
import type { Account } from '../types'
import type { DetectCandidate } from './detect'
import { GHOST_ID_PREFIX } from './ghostId'


/** One fixed grey, not a slot in the registry's COLORS palette. Ghosts have to be distinguishable from
 *  real accounts at a glance, and a per-ghost colour would just look like another registered account. */
const GHOST_COLOR = '#6b7280'

/** Ghosts are not registered, so they have no registration time. A fixed epoch keeps the mapping pure
 *  (a test can compare two calls) and still parses, so any date formatter that reaches it survives. */
const GHOST_CREATED_AT = new Date(0).toISOString()

/** Same rule as detect.ts's normalize — the id has to survive a restart and must not change when the
 *  same directory arrives spelled differently (drive-letter case, forward slashes). */
const normalizeDir = (p: string): string => path.resolve(p).toLowerCase()

/**
 * Turns detection candidates into account-shaped sources for the history index.
 *
 * Every `getAccounts()` use inside HistoryIndex reads only `{ id, configDir, provider }` — project
 * listing, session parsing, preview, locateEntry, the watcher and the dir-cache key — so handing it
 * these keeps the index itself unchanged.
 *
 * The caller decides what counts as a candidate. It must exclude registered directories (a registered
 * account already has a real Account) but NOT the dismissed ones: declining to suggest an account again
 * and showing its past history are separate requests.
 */
export function ghostAccounts(candidates: DetectCandidate[]): Account[] {
  return candidates.map((c) => ({
    id: GHOST_ID_PREFIX + normalizeDir(c.configDir),
    label: c.suggestedLabel,
    configDir: c.configDir,
    provider: c.provider,
    color: GHOST_COLOR,
    createdAt: GHOST_CREATED_AT
  }))
}
