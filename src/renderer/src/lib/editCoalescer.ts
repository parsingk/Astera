// The file editor's text on its way to App (second pass R2-1). Every keystroke built the whole document as a string and
// stored it in App's state, drawing App and every pane under it again; on a large file with sessions open that was input
// lag. An editor marks itself changed per keystroke and its text goes once a burst settles. Anything that reads the
// buffers (save, a tab's close, an outside change to the file) calls `flushPendingEdits` first, so it never reads text
// older than what is on screen.

/** How long the keys must pause before the text goes to App. */
export const EDIT_COALESCE_MS = 120
/** The longest a burst of typing holds its text back (final review C1: the wait restarts on every key). */
export const EDIT_MAX_WAIT_MS = 1_000

export interface EditCoalescer {
  /** The document changed: send it once this burst settles. Reads nothing now. */
  changed(): void
  /** Sends what is pending now; nothing when nothing is. */
  flush(): void
  /** Drops what is pending without sending it, and stops. */
  dispose(): void
}

const pending = new Set<EditCoalescer>()

/** Sends every editor's pending text now. */
export function flushPendingEdits(): void {
  for (const c of [...pending]) c.flush()
}

export function createEditCoalescer(o: { read: () => string; send: (text: string) => void; delayMs?: number }): EditCoalescer {
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  /** When the burst now pending began, by Date.now. */
  let since = 0
  const self: EditCoalescer = {
    changed: () => {
      if (disposed) return
      if (!pending.has(self)) since = Date.now()
      pending.add(self)
      if (timer !== null) clearTimeout(timer)
      const wait = Math.min(o.delayMs ?? EDIT_COALESCE_MS, Math.max(0, since + EDIT_MAX_WAIT_MS - Date.now()))
      timer = setTimeout(() => self.flush(), wait)
    },
    flush: () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      if (!pending.delete(self) || disposed) return
      o.send(o.read())
    },
    dispose: () => {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      pending.delete(self)
    }
  }
  return self
}

/** The texts an editor sent App and has not seen come back yet (final review C1). App's copy returns to the editor after a
 *  render that can trail the keys typed since; that echo is not an outside change, and replacing the document with it
 *  lost those keys, moved the cursor to the start and wiped undo. */
export interface EchoLedger {
  sent(text: string): void
  /** Whether `content` is one of the texts sent (it and everything sent before it are then forgotten). */
  isEcho(content: string): boolean
}

export function createEchoLedger(max = 32): EchoLedger {
  const texts: string[] = []
  return {
    sent: (text) => {
      texts.push(text)
      if (texts.length > max) texts.shift()
    },
    isEcho: (content) => {
      const i = texts.lastIndexOf(content)
      if (i < 0) return false
      texts.splice(0, i + 1)
      return true
    }
  }
}
