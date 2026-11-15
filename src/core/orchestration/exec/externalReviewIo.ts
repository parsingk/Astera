// The files an external review writes (its prompt, its convergence verdict, its transcript), as both drivers do it.
// Node only: it lives beside externalReview.ts, not in it, which the core of the web build may read.
import { appendFileSync, mkdirSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

/** `writeFile` and `appendLog` of `ExternalReviewDeps`. The transcript is best effort: a write that fails is logged and
 *  never reaches the review (and the append is synchronous, so there is no rejection to leave unhandled). */
export function externalReviewIo(log: (m: string) => void): {
  writeFile(file: string, text: string): Promise<void>
  appendLog(file: string, line: string): void
} {
  return {
    writeFile: async (file, text) => {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, text, 'utf8')
    },
    appendLog: (file, line) => {
      try {
        mkdirSync(path.dirname(file), { recursive: true })
        appendFileSync(file, `${line}\n`, 'utf8')
      } catch (e) {
        log(`external review transcript could not be written (${file}): ${String(e)}`)
      }
    }
  }
}
