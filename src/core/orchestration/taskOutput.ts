// Paged reads of a Task's output: a failed check's captured tail, and the latest worker's terminal tail.
// Pure helpers; the Host commands `tasks-check-output` and `tasks-output` in command.ts wrap them.
import type { Task } from './types'

export type CheckOutputSlice = { check: string; total: number; offset: number; text: string }

/** `text` after its first line break: what is left of a text cut from the front once the partial
 *  line it begins with is gone. A cut can fall inside a secret, whose tail alone matches no pattern
 *  of the filter, so the partial line is dropped rather than redacted. With no line break (a
 *  minified stack trace, a JSON error blob) only up to the first whitespace goes, since a secret is
 *  a run without whitespace; with no whitespace either, nothing is left. */
export function dropPartialLine(text: string): string {
  const line = text.indexOf('\n')
  if (line >= 0) return text.slice(line + 1)
  const space = text.search(/\s/)
  return space < 0 ? '' : text.slice(space + 1)
}

/** The last `cap` characters of `all`, and when that cut a line, from the next line on: what a
 *  check keeps of its log (4000) and a worker tail of its output (64 KB). */
export function cutTail(all: string, cap: number): string {
  if (all.length <= cap) return all
  const kept = all.slice(-cap)
  return all[all.length - cap - 1] === '\n' ? kept : dropPartialLine(kept)
}

/** A slice of one failed check's `outputTail`. Without a name, the first check that kept output. */
export function checkOutputSlice(
  task: Task,
  check: string | undefined,
  offset: number,
  limit: number
): CheckOutputSlice | { error: string } {
  const withOutput = (task.checks ?? []).filter((c) => c.outputTail !== undefined && c.outputTail !== '')
  const found = check ? (task.checks ?? []).find((c) => c.configId === check || c.name === check) : withOutput[0]
  if (check && !found) return { error: `no check named ${check} on task ${task.id}` }
  if (!found || !found.outputTail) return { error: `task ${task.id} has no failed check output` }
  const text = found.outputTail
  return { check: found.configId, total: text.length, offset, text: text.slice(offset, offset + limit) }
}

/** `lines` lines ending `skipLines` lines before the end of `text`, oldest first. `more`: older lines exist.
 *  Any run of CR and LF at the end is a line end: WorkerTails.read trims only the LFs, so a terminal's
 *  CRLF tail reaches here ending in a lone CR. */
export function tailWindow(
  text: string,
  skipLines: number,
  lines: number
): { lines: string[]; totalLines: number; more: boolean } {
  const all = text === '' ? [] : text.replace(/[\r\n]+$/, '').split(/\r?\n/)
  const end = Math.max(0, all.length - skipLines)
  const start = Math.max(0, end - lines)
  return { lines: all.slice(start, end), totalLines: all.length, more: start > 0 }
}
