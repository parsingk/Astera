import { isPathWithin } from '../files/tree'
import type { DetectCandidate } from './detect'

/**
 * Narrows detection candidates down to the ones worth offering as new accounts.
 *
 * A directory under one of the app's own accounts roots is there because create() made it for an account.
 * If it is no longer registered, the user unregistered it, and offering it straight back is the bug this
 * removes. Unlike the remembered dismissals (AccountRegistry.dismissedDirs) this needs no record, so it
 * covers accounts unregistered before that record existed too — the reason it is a rule rather than a
 * one-time migration that would linger in load() forever.
 *
 * The two mechanisms cover different ground and both are needed: this one owns the directories the app
 * created, while the dismissal record owns everything else the user can unregister — the ambient
 * <home>/.claude, its <home>/.claude-* siblings, and any folder imported by hand.
 *
 * Skipped entirely when nothing is registered. A fresh install, or a recovery after accounts.json was
 * lost, has to be able to find those directories again — detection is the way back, and with no record
 * there is nothing to tell "unregistered" apart from "never registered" anyway.
 */
export function suggestableCandidates(
  candidates: DetectCandidate[],
  opts: { accountsRoots: string[]; registeredCount: number }
): DetectCandidate[] {
  if (opts.registeredCount === 0) return candidates
  return candidates.filter((c) => !opts.accountsRoots.some((root) => isPathWithin(root, c.configDir)))
}
