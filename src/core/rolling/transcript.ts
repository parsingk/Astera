// File copy for the rolling transcript relay. Assembling the target path is done by mapTargetPath in
// the per-provider history strategy — the side that knows the disk layout builds the path.
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Creates the target folder, then copies (overwriting). On Windows the history watcher can hold the
 *  file momentarily, so we retry at short intervals. If every attempt fails, the last error is thrown. */
export async function copyTranscript(src: string, dest: string, attempts = 3, delayMs = 200): Promise<void> {
  // For single-account auto-resume the target account = the current account, so source = target.
  // Copying onto itself is a no-op (fs.copyFile(a,a) risks an error or file corruption depending on the
  // platform) — skip when the paths are the same. For an ambient account the path Claude resolved and
  // the registry configDir can differ in case, so we compare case-insensitively per the project-wide
  // rule (normalizePath in manager.ts) — Windows first.
  if (path.resolve(src).toLowerCase() === path.resolve(dest).toLowerCase()) return
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
