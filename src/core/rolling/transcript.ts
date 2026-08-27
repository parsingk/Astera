// File copy for the rolling transcript relay. Assembling the target path is done by mapTargetPath in
// the per-provider history strategy — the side that knows the disk layout builds the path.
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Whether the two paths name the same file. For an ambient account the path Claude resolved and the
 *  registry configDir can differ in case, so the comparison is case-insensitive per the project-wide
 *  rule (normalizePath in manager.ts) — Windows first.
 *
 *  **Two callers, and the second is why it is exported.** copyTranscript below skips a self-copy with
 *  it. And ipc's resume wiring reads the very same identity as a different fact: the copy target is
 *  built from the *target* account's configDir, so it equals the source exactly when the resume did not
 *  cross accounts. Both questions are "is this one file or two", so they must not answer differently. */
export function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

/** Creates the target folder, then copies (overwriting). On Windows the history watcher can hold the
 *  file momentarily, so we retry at short intervals. If every attempt fails, the last error is thrown. */
export async function copyTranscript(src: string, dest: string, attempts = 3, delayMs = 200): Promise<void> {
  // For single-account auto-resume the target account = the current account, so source = target.
  // Copying onto itself is a no-op (fs.copyFile(a,a) risks an error or file corruption depending on the
  // platform) — skip when the paths are the same.
  if (samePath(src, dest)) return
  await fs.mkdir(path.dirname(dest), { recursive: true })
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.copyFile(src, dest)
      return
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}
