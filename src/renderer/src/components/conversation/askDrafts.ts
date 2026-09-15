// The answers composed on a question card, kept across the pane unmounting.
//
// The card's state is component state, and the pane is unmounted whenever the tab shows the terminal
// instead (PaneGrid.tsx) — which the card's own "go to the terminal" button does. Coming back re-runs
// the mount effect, which would start the card blank for the very question the person was halfway
// through. So the answers are also kept here, keyed by the call, the way drafts.ts keeps the composer's
// text across the same unmount. One question is ever waiting per session, and a call is asked once, so
// the map never holds more than a handful of entries; `forgetOtherAskAnswers` trims it when a new call
// arrives.
import type { Answer } from '../../../../core/prompts/askUserQuestion'

const kept = new Map<string, Answer[]>()

export function rememberAskAnswers(toolUseId: string, answers: Answer[]): void {
  kept.set(toolUseId, answers)
}

export function recallAskAnswers(toolUseId: string): Answer[] | null {
  return kept.get(toolUseId) ?? null
}

/** A new call is waiting: whatever was composed for earlier calls is no longer wanted. */
export function forgetOtherAskAnswers(keepToolUseId: string): void {
  for (const id of [...kept.keys()]) if (id !== keepToolUseId) kept.delete(id)
}

/** Test seam. */
export function resetAskDraftsForTest(): void {
  kept.clear()
}
