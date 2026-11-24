import { useEffect, useRef, useState } from 'react'
import { pollFileIndex, type FileIndexState } from '../lib/fileIndexPoll'

/** How often Quick Open asks again while the first walk of a large project is still listing: the composer's `@` menu's
 *  pace (ConversationPane), so the two menus over the one index behave alike. */
const POLL_MS = 400

type Answered = FileIndexState & {
  /** The project and query these rows answer (answerKey), or null before the first answer. */
  answeredFor: string | null
}

export type QuickOpenFiles = FileIndexState & {
  /** The rows answer the project and the query the box holds now. Rows answering an older query, or the project the box
   *  was on before, are still shown while the new answer is asked for, so the list does not flash empty on every
   *  keystroke; Enter waits until they are current (lib/quickOpen.ts filesWaiting). */
  current: boolean
}

const NONE: Answered = { paths: [], indexing: false, unavailable: false, answeredFor: null }

const answerKey = (root: string, text: string): string => `${root}\n${text}`

/**
 * Quick Open's files matching `text` under `root` (main/quickOpen.ts), asked again while the first walk of the project is
 * still listing, or while the held list answers during a re-walk, so the rows fill in and settle as it goes.
 *
 * A new query stops the asking for the old one before it starts its own, so an answer that comes back late for a query
 * no longer in the box is dropped rather than shown over the newer one (pollFileIndex's stop, returned as the effect's
 * cleanup). A refused or failed ask, a folder the path guard does not allow, reads as unavailable.
 *
 * The first ask for a project asks main to walk it again: the explorer's watcher keeps the list current only while the
 * explorer is open, and a file deleted from a terminal with it closed would otherwise be offered (main/quickOpen.ts).
 */
export function useQuickOpenFiles(root: string | null, text: string, enabled: boolean): QuickOpenFiles {
  const [files, setFiles] = useState<Answered>(NONE)
  /** The project a fresh list has been asked for, since this box opened. */
  const refreshedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled || !root) {
      setFiles(NONE)
      return
    }
    let first = refreshedFor.current !== root
    refreshedFor.current = root
    const key = answerKey(root, text)
    return pollFileIndex(
      () => {
        const asked = window.api.files.quickOpen(root, text, first)
        first = false
        return asked
      },
      (s) => setFiles({ ...s, answeredFor: key }),
      () => setFiles({ paths: [], indexing: false, unavailable: true, answeredFor: key }),
      { pollMs: POLL_MS }
    )
  }, [root, text, enabled])
  return {
    paths: files.paths,
    indexing: files.indexing,
    unavailable: files.unavailable,
    ...(files.truncated ? { truncated: true as const } : {}),
    current: enabled && root !== null && files.answeredFor === answerKey(root, text)
  }
}
