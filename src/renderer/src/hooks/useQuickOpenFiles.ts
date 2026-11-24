import { useEffect, useRef, useState } from 'react'
import { pollFileIndex, type FileIndexState } from '../lib/fileIndexPoll'

/** How often Quick Open asks again while the first walk of a large project is still listing: the composer's `@` menu's
 *  pace (ConversationPane), so the two menus over the one index behave alike. */
const POLL_MS = 400

export type QuickOpenFiles = FileIndexState & {
  /** The query these rows answer, or null before the first answer. Rows answering an older query are still shown while
   *  the newer one is asked, so the list does not flash empty on every keystroke; Enter waits until they are current. */
  answeredFor: string | null
}

const NONE: QuickOpenFiles = { paths: [], indexing: false, unavailable: false, answeredFor: null }

/**
 * Quick Open's files matching `text` under `root` (main/quickOpen.ts), asked again while the first walk of the project is
 * still listing, so the rows fill in as it goes.
 *
 * A new query stops the asking for the old one before it starts its own, so an answer that comes back late for a query
 * no longer in the box is dropped rather than shown over the newer one (pollFileIndex's stop, returned as the effect's
 * cleanup). A refused or failed ask, a folder the path guard does not allow, reads as unavailable.
 *
 * The first ask for a project asks main to walk it again: the explorer's watcher keeps the list current only while the
 * explorer is open, and a file deleted from a terminal with it closed would otherwise be offered (main/quickOpen.ts).
 */
export function useQuickOpenFiles(root: string | null, text: string, enabled: boolean): QuickOpenFiles {
  const [files, setFiles] = useState<QuickOpenFiles>(NONE)
  /** The project a fresh list has been asked for, since this box opened. */
  const refreshedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled || !root) {
      setFiles(NONE)
      return
    }
    let first = refreshedFor.current !== root
    refreshedFor.current = root
    return pollFileIndex(
      () => {
        const asked = window.api.files.quickOpen(root, text, first)
        first = false
        return asked
      },
      (s) => setFiles({ ...s, answeredFor: text }),
      () => setFiles({ paths: [], indexing: false, unavailable: true, answeredFor: text }),
      { pollMs: POLL_MS }
    )
  }, [root, text, enabled])
  return files
}
