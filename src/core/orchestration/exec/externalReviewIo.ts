// The files an external review writes (its prompt, its convergence verdict, its transcript), as both drivers do it.
// Node only: it lives beside externalReview.ts, not in it, which the core of the web build may read.
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

/** A transcript older than this is removed when a review starts (final fix wave C1). */
export const REVIEW_LOG_MAX_AGE_MS = 14 * 24 * 60 * 60_000
/** Beyond this many transcripts, the oldest are removed when a review starts. */
export const REVIEW_LOG_KEEP = 200

/** `writeFile`, `appendLog` and `pruneReviewLogs` of `ExternalReviewDeps`. The transcript is best effort: a write that
 *  fails is logged and never reaches the review (and the append is synchronous, so there is no rejection to leave
 *  unhandled). */
export function externalReviewIo(log: (m: string) => void): {
  writeFile(file: string, text: string): Promise<void>
  appendLog(file: string, line: string): void
  pruneReviewLogs(dir: string): void
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
    },
    // The transcripts have a folder of their own, out of the spec sweep's reach, so they need a retention of their own.
    // Synchronous and never throws: a folder not made yet has nothing in it, and a file that will not go is retried next time.
    pruneReviewLogs: (dir) => {
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code !== 'ENOENT') log(`external review transcripts could not be pruned (${dir}): ${String(e)}`)
        return
      }
      const files: { file: string; mtime: number }[] = []
      for (const name of names) {
        const file = path.join(dir, name)
        try {
          const st = statSync(file)
          if (st.isFile()) files.push({ file, mtime: st.mtimeMs })
        } catch {
          // gone between the listing and the look
        }
      }
      files.sort((a, b) => b.mtime - a.mtime)
      const oldest = Date.now() - REVIEW_LOG_MAX_AGE_MS
      for (const [i, f] of files.entries()) {
        if (i < REVIEW_LOG_KEEP && f.mtime >= oldest) continue
        try {
          rmSync(f.file, { force: true })
        } catch (e) {
          log(`external review transcript could not be pruned (${f.file}): ${String(e)}`)
        }
      }
    }
  }
}
