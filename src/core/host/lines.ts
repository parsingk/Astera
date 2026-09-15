// Turns a stream of chunks into complete lines. Shared by the Host's process registry and the app's
// no-Host fallback, so the two cannot disagree about what a line is: everything up to a `\n`, with a
// `\r` before it dropped. Lives under core/host because the Host bundle may import nothing else
// (see src/host/registry.ts's own note).

export interface LineSplitter {
  push(chunk: string): void
  /** Delivers whatever is left without a newline — the last line of a process that exited mid-line. */
  flush(): void
}

export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  let partial = ''
  return {
    push(chunk) {
      partial += chunk
      let at = partial.indexOf('\n')
      while (at !== -1) {
        let line = partial.slice(0, at)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        partial = partial.slice(at + 1)
        onLine(line)
        at = partial.indexOf('\n')
      }
    },
    flush() {
      if (partial === '') return
      const line = partial.endsWith('\r') ? partial.slice(0, -1) : partial
      partial = ''
      onLine(line)
    }
  }
}
