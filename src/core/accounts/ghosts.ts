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
 *  ghost; the cost is that two linux config dirs differing only in case would share a ghost id, and
 *  ghostAccounts keeps only the first of them (see there). */
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
 *
 * **One ghost per id, the first one kept.** On linux detection keeps `~/.claude-x` and `~/.Claude-x`
 * apart, but their ids fold to one (normalizeDir). Two accounts with one id would have the second
 * overwrite the first wherever the index groups by account id, and an entry id would resolve to a ghost
 * whose folder does not hold that session. Keeping the first is what happened before detection learnt
 * case on linux — it merged the two then. A per-folder exact-case id for the second was the other way
 * out, but an id that depends on which of the two detection lists first is not stable across restarts,
 * and stability is the point of the id.
 */
export function ghostAccounts(candidates: DetectCandidate[]): Account[] {
  const seen = new Set<string>()
  return candidates.flatMap((c) => {
    const id = GHOST_ID_PREFIX + normalizeDir(c.configDir)
    if (seen.has(id)) return []
    seen.add(id)
    return [ghostOf(id, c)]
  })
}

function ghostOf(id: string, c: DetectCandidate): Account {
  return {
    id,
    label: c.suggestedLabel,
    configDir: c.configDir,
    provider: c.provider,
    color: GHOST_COLOR,
    createdAt: GHOST_CREATED_AT
  }
}
