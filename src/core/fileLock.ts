// A lock more than one process honours: a file made with O_EXCL that names its holder's pid and start time. Lifted
// from the secret store (remote runtime design §4.6) so other files written by several processes at once, such as
// Higgsfield's ledger and account list (audit U-8), share the same tested rules:
// - a holder that is gone, or has held it past staleMs, loses it to the next caller;
// - a lock is only ever removed through removeIfUnchanged, so a remover never deletes a lock another process took
//   after this one read the old one (secret store Phase 2 review I2);
// - a lock left empty by a writer that died between creating and filling it is judged by the file's age (I3).
import { constants, promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { pidLives as realPidLives } from './host/pidFile'

const GUARD_STALE_MS = 10_000

/** Locks this process took and could not remove at release (audit U-5): known as its own, and broken at once. */
const abandoned = new Set<string>()

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface FileLockOptions {
  /** How long to wait for a live holder before giving up. Default 5 s. */
  waitMs?: number
  /** A holder older than this is taken to have died holding it. Default 30 s. */
  staleMs?: number
  now?: () => number
  pidLives?: (pid: number) => boolean
  /** The error thrown when the wait runs out. */
  busy?: () => Error
}

export class FileLockBusy extends Error {
  readonly code = 'FILE_LOCK_BUSY'
  constructor(lockFile: string) {
    super(`another process has held ${lockFile} too long`)
  }
}

/** Takes the lock at `lockFile`, using `guardFile` for taking turns at breaking a stale one. Answers the release. */
export async function takeFileLock(
  a: FileLockOptions & { lockFile: string; guardFile: string }
): Promise<() => Promise<void>> {
  const { lockFile, guardFile } = a
  const now = a.now ?? Date.now
  const lives = a.pidLives ?? realPidLives
  const waitMs = a.waitMs ?? 5000
  const staleMs = a.staleMs ?? 30_000

  /**
   * Removes the lock only if it still holds `seen`. Removers take turns through an O_EXCL guard file, and the only way a
   * lock disappears is through here (taking one is O_EXCL on the lock itself). Answers 'busy' when another remover
   * holds the guard; a guard older than GUARD_STALE_MS was left by a remover that died, and is cleared.
   */
  const removeIfUnchanged = async (seen: string): Promise<'removed' | 'changed' | 'busy'> => {
    try {
      await (await fs.open(guardFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)).close()
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' && (e as NodeJS.ErrnoException).code !== 'EPERM') throw e
      const st = await fs.stat(guardFile).catch(() => null)
      if (st && Date.now() - st.mtimeMs > GUARD_STALE_MS) await fs.rm(guardFile, { force: true })
      return 'busy'
    }
    try {
      const held = await fs.readFile(lockFile, 'utf8').catch(() => null)
      if (held !== seen) return 'changed'
      await fs.rm(lockFile, { force: true })
      return 'removed'
    } finally {
      await fs.rm(guardFile, { force: true })
    }
  }

  const mine = JSON.stringify({ pid: process.pid, startedAt: now(), nonce: randomBytes(8).toString('hex') })
  const deadline = now() + waitMs
  for (;;) {
    let created = false
    try {
      const h = await fs.open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      created = true
      try {
        await h.writeFile(mine)
      } finally {
        await h.close()
      }
      return async () => {
        // Released the same way a breaker removes, so a lock that was taken from this holder is never deleted.
        for (let tries = 0; tries < 200; tries++) {
          if ((await removeIfUnchanged(mine)) !== 'busy') return
          await pause(25)
        }
        abandoned.add(mine)
      }
    } catch (e) {
      // A lock this call made but could not fill would look like a writer mid-fill to everyone else: take it back.
      if (created) {
        await fs.rm(lockFile, { force: true })
        throw e
      }
      // Windows answers EPERM, not EEXIST, for a lock whose deletion is still pending.
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'EPERM') throw e
    }
    const held = await fs.readFile(lockFile, 'utf8').catch(() => null)
    if (held !== null) {
      let stale: boolean
      if (held === '') {
        // Its writer may be between creating it and filling it. Judged by the file's own age, so a lock left empty
        // by a writer that died is broken by the next caller, not waited on forever.
        const st = await fs.stat(lockFile).catch(() => null)
        stale = st !== null && Date.now() - st.mtimeMs > staleMs
      } else {
        let owner: { pid?: unknown; startedAt?: unknown } | null = null
        try {
          owner = JSON.parse(held) as { pid?: unknown; startedAt?: unknown }
        } catch {
          owner = null
        }
        stale =
          !owner ||
          typeof owner.pid !== 'number' ||
          typeof owner.startedAt !== 'number' ||
          !lives(owner.pid) ||
          now() - owner.startedAt > staleMs
      }
      if (abandoned.has(held)) stale = true
      if (stale && (await removeIfUnchanged(held)) === 'removed') {
        abandoned.delete(held)
        continue
      }
    }
    if (now() >= deadline) throw a.busy ? a.busy() : new FileLockBusy(lockFile)
    await pause(25)
  }
}

/** Runs `fn` holding `dir/.lock` (made with the directory when missing), and releases it however `fn` ends. */
export async function withFileLock<T>(dir: string, fn: () => Promise<T>, opts: FileLockOptions = {}): Promise<T> {
  await fs.mkdir(dir, { recursive: true })
  const release = await takeFileLock({ ...opts, lockFile: path.join(dir, '.lock'), guardFile: path.join(dir, '.lock-break') })
  try {
    return await fn()
  } finally {
    await release()
  }
}
