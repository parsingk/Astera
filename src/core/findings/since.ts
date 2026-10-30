// When this release first ran on the profile (lifecycle plan ruling 2): `<profile>/findings-history.json`,
// `{ version: 1, since }`, stamped by the first read. Every history this release began recording counts from it (an
// Observe that was on before it, credential uses, a shared extension with no `addedAt`), so nothing is called unused on
// days nobody recorded (design §4).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { profilePaths } from '../profile/paths'
import { keepDamaged, readStoreFile } from '../storeFile'
import { oneAtATime, writeThroughTmp } from '../accounts/fileQueue'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The stamp the file's text holds, or null when it holds none that reads as a time. */
function sinceOf(text: string): string | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  return isRecord(v) && v.version === 1 && typeof v.since === 'string' && !Number.isNaN(Date.parse(v.since)) ? v.since : null
}

/**
 * The stamp, written as `nowMs` when there is none. A damaged file is kept aside (`<file>.bak`) and stamped afresh: the
 * stamp only ever holds findings back, so starting it now loses nothing but time. A file that could not be read is not
 * written over (storeFile.ts: nothing read, nothing healed), and neither failure rejects: `nowMs` stands in, which ages
 * nothing, so no usage finding is raised until a stamp is kept. One read at a time per file, so two first reads in this
 * process do not stamp twice.
 */
export async function readFindingsSince(profileDir: string, nowMs: number): Promise<string> {
  const file = profilePaths(profileDir).findingsHistory
  const now = new Date(nowMs).toISOString()
  let since = now
  await oneAtATime(file, async () => {
    const read = await readStoreFile(file)
    if (read.kind === 'unreadable') return
    if (read.kind === 'text') {
      const kept = sinceOf(read.text)
      if (kept !== null) {
        since = kept
        return
      }
      await keepDamaged(file, read.text)
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    await writeThroughTmp(file, JSON.stringify({ version: 1, since: now }, null, 2) + '\n').catch(() => {})
  }).catch(() => {})
  return since
}
