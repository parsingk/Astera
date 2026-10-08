// The file editor's text on its way to App (second pass R2-1). Every keystroke built the whole document as a string and
// stored it in App's state, drawing App and every pane under it again; on a large file with sessions open that was input
// lag. An editor marks itself changed per keystroke and its text goes once a burst settles. Anything that reads the
// buffers (save, a tab's close, an outside change to the file) calls `flushPendingEdits` first, so it never reads text
// older than what is on screen.

/** How long a burst of keystrokes may run before the text goes to App. */
export const EDIT_COALESCE_MS = 120

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
  const self: EditCoalescer = {
    changed: () => {
      if (disposed) return
      pending.add(self)
      if (timer === null) timer = setTimeout(() => self.flush(), o.delayMs ?? EDIT_COALESCE_MS)
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
