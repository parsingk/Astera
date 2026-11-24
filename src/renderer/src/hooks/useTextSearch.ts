import { useEffect, useRef, useState } from 'react'
import { TEXT_SEARCH_MAX_QUERY } from '../../../core/files/textMatch'
import { pollTextSearch, type TextSearchState } from '../lib/textSearchPoll'

/** How long typing has to pause before a search is asked for (spec W2 input debounce). A file name is matched in a couple
 *  of milliseconds and needs none; reading a project's files takes a tenth of a second or more, and a word typed quickly
 *  should cost one search, not one per letter. */
const DEBOUNCE_MS = 150
/** How often the rows are asked for again while main reads files. main waits up to a tenth of a second itself before
 *  answering, so rows arrive about five times a second. */
const POLL_MS = 100

type Answered = TextSearchState & {
  /** The project and query these rows answer (answerKey), or null before the first answer. */
  answeredFor: string | null
}

export type TextSearch = TextSearchState & {
  /** The rows answer the project and the query the box holds now (or there is nothing to answer: no query, or one too
   *  long to search). Rows of an older query stay on screen while the newer one is asked for; Enter waits until they
   *  are current (lib/quickOpen.ts rowsWaiting). */
  current: boolean
}

const NONE: Answered = { matches: [], searching: false, unavailable: false, answeredFor: null }

const answerKey = (root: string, text: string): string => `${root}\n${text}`

/** Whether there is something to search: not nothing, and not longer than main searches (the box says so instead). */
const searchable = (text: string): boolean => text !== '' && text.length <= TEXT_SEARCH_MAX_QUERY

/**
 * The palette's text search: the lines of the files under `root` holding `text` (main/textSearch.ts), asked for once
 * typing pauses and again while main reads, so the rows fill in.
 *
 * A new query stops the asking for the old one (the effect's cleanup), so a late answer for a query no longer in the box
 * is dropped; main stops the old search itself when the new query reaches it. When the box stops searching this project
 * (it closes, leaves `%`, or moves to another project), main is told with an empty query, so it stops reading files for
 * a search nobody will see.
 *
 * The first ask that goes out for a project asks main to walk it again, as Quick Open does: the explorer's watcher keeps
 * the list current only while the explorer is open.
 */
export function useTextSearch(root: string | null, text: string, enabled: boolean): TextSearch {
  const [found, setFound] = useState<Answered>(NONE)
  /** The project a fresh list has been asked for, since this box opened. Set when the ask goes out, not when typing
   *  starts it: an ask the debounce drops has refreshed nothing. */
  const refreshedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled || !root) {
      setFound(NONE)
      return
    }
    if (!searchable(text)) {
      setFound(NONE)
      // Back to a bare %: main stops reading for the query that was there
      void window.api.files.searchText(root, '').catch(() => {})
      return
    }
    let first = refreshedFor.current !== root
    const key = answerKey(root, text)
    return pollTextSearch(
      () => {
        const asked = window.api.files.searchText(root, text, first)
        if (first) refreshedFor.current = root
        first = false
        return asked
      },
      (s) => setFound({ ...s, answeredFor: key }),
      () => setFound({ ...NONE, unavailable: true, answeredFor: key }),
      { delayMs: DEBOUNCE_MS, pollMs: POLL_MS }
    )
  }, [root, text, enabled])
  useEffect(() => {
    if (!enabled || !root) return
    return () => {
      void window.api.files.searchText(root, '').catch(() => {})
    }
  }, [root, enabled])
  return {
    matches: found.matches,
    searching: found.searching,
    unavailable: found.unavailable,
    ...(found.truncated ? { truncated: true as const } : {}),
    ...(found.fileCut ? { fileCut: true as const } : {}),
    ...(found.partial ? { partial: true as const } : {}),
    current: !enabled || root === null || !searchable(text) || found.answeredFor === answerKey(root, text)
  }
}
