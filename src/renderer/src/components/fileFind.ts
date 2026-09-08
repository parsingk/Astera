import type { EditorState } from '@codemirror/state'
import type { SearchQuery } from '@codemirror/search'

/** How many matches a query has in the document, and which one the selection is sitting on.
 *
 *  CodeMirror does not count. Its own panel shows no total at all, so the number in the find bar has
 *  to come from walking the document. The walk is linear in the document length, which is why the
 *  caller debounces it instead of running one per keystroke.
 *
 *  `index` is null when the selection is not on a match, and that is the ordinary state right after
 *  typing: CodeMirror's search does not move the cursor until you ask for the next match, so the bar
 *  shows a bare total until then rather than a position that would be a lie.
 *
 *  The query must be `valid` — an invalid regular expression makes `getCursor` throw when it compiles
 *  the pattern. The caller checks, because it has to distinguish a bad pattern from zero matches
 *  anyway. */
export function countMatches(
  state: EditorState,
  query: SearchQuery
): { index: number | null; total: number } {
  const sel = state.selection.main
  const cursor = query.getCursor(state)
  let total = 0
  let index: number | null = null
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    total += 1
    if (step.value.from === sel.from && step.value.to === sel.to) index = total
  }
  return { index, total }
}
