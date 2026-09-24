import path from 'node:path'
import type { Account } from '../types'
import type { DetectCandidate } from './detect'
import { GHOST_ID_PREFIX } from './ghostId'


/** One fixed grey, deliberately outside ACCOUNT_COLORS (accounts/colors.ts). Ghosts have to be
 *  distinguishable from real accounts at a glance, and a per-ghost colour would just look like another
 *  registered account. Keeping it out of the palette also keeps it from colliding with one. */
const GHOST_COLOR = '#6b7280'

/** Ghosts are not registered, so they have no registration time. A fixed epoch keeps the mapping pure
 *  (a test can compare two calls) and still parses, so any date formatter that reaches it survives. */
const GHOST_CREATED_AT = new Date(0).toISOString()

/** The id has to survive a restart and must not change when the same directory arrives spelled
 *  differently (drive-letter case, forward slashes).
 *
 *  **Case is folded here on every platform, linux included — on purpose, unlike comparablePath.** This
 *  is not a comparison but an identifier that is stored: history entry ids embed it
 *  (`<accountId>:<sessionId>`), and the renderer keeps those ids in localStorage as the seen marks
 *  (HistoryBrowser, `cm.historySeen`). Folding on linux too keeps every stored mark pointing at its
 *  ghost; the cost is that two linux config dirs differing only in case would share a ghost id. */
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
