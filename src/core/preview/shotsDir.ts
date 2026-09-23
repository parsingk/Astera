import path from 'node:path'

/** Where screenshots are written. Kept as one function so the session spawn, which grants a Claude
 *  session read access to exactly this folder (--add-dir), names the same path this writes to. */
export function previewShotsDir(userData: string): string {
  return path.join(userData, 'preview', 'shots')
}
