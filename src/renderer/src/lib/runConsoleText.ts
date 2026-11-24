import type { Terminal } from '@xterm/xterm'

/** What a run console holds right now: its selection ('' for none) and the last lines of its buffer. */
export type RunConsoleText = { selection: string; tail: string[] }

const readers = new Map<string, () => RunConsoleText>()

/** RunPanel registers a reader for its xterm when it mounts; returns the unregister, which leaves alone a reader a newer
 *  console for the same run registered since. The console is the one place that knows what the person selected. */
export function registerRunConsole(runId: string, read: () => RunConsoleText): () => void {
  readers.set(runId, read)
  return () => {
    if (readers.get(runId) === read) readers.delete(runId)
  }
}

/** What that run's console holds, or null when none is registered or it cannot be read (disposed). */
export function readRunConsole(runId: string): RunConsoleText | null {
  const read = readers.get(runId)
  if (!read) return null
  try {
    return read()
  } catch {
    return null
  }
}

/** The last `count` lines of the terminal's buffer as the program printed them: a row xterm wrapped onto the next joins
 *  the row before it, and the blank rows below the last output are left off. */
export function bufferTail(term: Pick<Terminal, 'buffer'>, count: number): string[] {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) {
    const row = buf.getLine(i)
    if (!row) continue
    const text = row.translateToString(true)
    if (row.isWrapped && lines.length > 0) lines[lines.length - 1] += text
    else lines.push(text)
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.slice(-count)
}
