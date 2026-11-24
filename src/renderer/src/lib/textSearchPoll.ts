import type { TextMatch, TextSearchAnswer } from '../../../core/files/textMatch'

/** What the palette shows of a text search. */
export interface TextSearchState {
  matches: TextMatch[]
  /** main is still reading files: more rows may come. */
  searching: boolean
  /** The project could not be listed, or the ask was refused: there is nothing to wait for. */
  unavailable: boolean
  /** More lines match than are listed (main's row cap). */
  truncated?: true
  /** Only the shallow part of a large project was searched (the index's cap). */
  partial?: true
}

/** How many times one query asks again while main says it is still reading, before the box stops asking. main's search
 *  ends on its own (it reads a bounded list, a bounded size of each file); this is only the backstop, so the box never
 *  polls without end. At the hook's pace it is about two minutes, far past a cold search of a large project. */
export const TEXT_SEARCH_MAX_POLLS = 1_200

/**
 * Asks for a text search after `delayMs` (spec W2's input debounce: a word typed quickly is one search, not one per
 * letter), then again every `pollMs` while main says it is still reading files, so the rows fill in as it goes. It stops
 * as soon as an answer is done, after `maxPolls` asks at the most, or when stopped; an answer that comes back after it was
 * stopped is dropped, so rows of a query no longer in the box never replace the newer ones. A refused ask ends it quietly
 * (`onFailed`). Returns the function that stops it.
 */
export function pollTextSearch(
  ask: () => Promise<TextSearchAnswer>,
  onState: (s: TextSearchState) => void,
  onFailed: () => void,
  opts: {
    delayMs: number
    pollMs: number
    maxPolls?: number
    setTimer?: (fn: () => void, ms: number) => unknown
    clearTimer?: (t: unknown) => void
  }
): () => void {
  const maxPolls = opts.maxPolls ?? TEXT_SEARCH_MAX_POLLS
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  let stopped = false
  let timer: unknown = null
  let asked = 0
  const once = (): void => {
    timer = null
    asked++
    ask().then(
      ({ matches, searching, unavailable, truncated, partial }) => {
        if (stopped) return
        const more = searching && asked <= maxPolls
        onState({
          matches,
          searching: more,
          unavailable: unavailable === true,
          ...(truncated === true ? { truncated: true as const } : {}),
          ...(partial === true ? { partial: true as const } : {})
        })
        if (more) timer = setTimer(once, opts.pollMs)
      },
      () => {
        if (!stopped) onFailed()
      }
    )
  }
  timer = setTimer(once, opts.delayMs)
  return () => {
    stopped = true
    if (timer !== null) clearTimer(timer)
  }
}
