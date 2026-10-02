// Paged reads of a Task's output: a failed check's captured tail, and the latest worker's terminal tail.
// Pure helpers; the Host commands `tasks-check-output` and `tasks-output` in command.ts wrap them.
import type { Task } from './types'

export type CheckOutputSlice = { check: string; total: number; offset: number; text: string }

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
