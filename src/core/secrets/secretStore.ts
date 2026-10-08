// Owner-only secret files (remote runtime design §4.6, D5, X1-12). One backend in v1: files in a directory only this
// user can open, checked on every read, written only under a directory lock with a re-read inside it, so two
// processes never lose each other's update. Used by the Host (identity, client records) and by controllers (runtime
// profiles and tokens). Nothing falls back to an unchecked read.
import { constants, lstatSync, promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { pidLives as realPidLives } from '../host/pidFile'
import { pathChain, posixProblem, symlinkProblem, type StatLike } from './posixCheck'
import { sddlProblem, systemWinAcl, type WinAcl } from './winAcl'

export class SecretFileUnsafe extends Error {
  readonly code = 'SECRET_FILE_UNSAFE'
  readonly path: string
  readonly reason: string
  constructor(p: string, reason: string) {
    super(`${p} is not safe to use for secrets: ${reason}`)
    this.path = p
    this.reason = reason
  }
}

export class SecretStoreBusy extends Error {
  readonly code = 'SECRET_STORE_BUSY'
  constructor(dir: string) {
    super(`another process has held the lock on ${dir} too long`)
  }
}

export interface SecretTx {
  read(name: string): Promise<string | null>
  write(name: string, text: string): Promise<void>
  remove(name: string): Promise<void>
  list(): Promise<string[]>
}

export interface SecretStore {
  dir: string
  /** The file's text, or null when it or the store does not exist. Never creates anything. */
  read(name: string): Promise<string | null>
  /** Creates and secures the store on first use, then runs `fn` holding the store's lock. */
  withLock<T>(fn: (tx: SecretTx) => Promise<T>): Promise<T>
}

const NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}$/
const LOCK = 'lock'
const TMP = '.tmp-'
const BREAK_GUARD = '.lock-break'
const GUARD_STALE_MS = 10_000

const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT'

export function openSecretStore(a: {
  dir: string
  profileDir: string
  platform?: NodeJS.Platform
  acl?: WinAcl
  lstat?: (p: string) => StatLike
  uid?: number
  lockWaitMs?: number
  staleMs?: number
  now?: () => number
  pidLives?: (pid: number) => boolean
}): SecretStore {
  const dir = path.resolve(a.dir)
  const platform = a.platform ?? process.platform
  const lstat = a.lstat ?? ((p: string): StatLike => lstatSync(p))
  const now = a.now ?? Date.now
  const lives = a.pidLives ?? realPidLives
  const waitMs = a.lockWaitMs ?? 5000
  const staleMs = a.staleMs ?? 30_000
  let acl: WinAcl | null = a.acl ?? null
  const winAcl = (): WinAcl => (acl ??= systemWinAcl())
  /** Path → the stat it passed the ACL check with, like httpToken.ts: `icacls` runs again only after a change. */
  const passed = new Map<string, string>()

  const fileOf = (name: string): string => {
    if (!NAME.test(name) || name === LOCK) throw new Error(`not a secret file name: ${JSON.stringify(name)}`)
    return path.join(dir, name)
  }

  const aclCheck = async (p: string, isDir: boolean): Promise<void> => {
    const st = await fs.stat(p)
    const key = `${st.ino}:${st.ctimeMs}:${st.mtimeMs}:${st.size}`
    if (passed.get(p) === key) return
    const problem = sddlProblem(await winAcl().sddlOf(p), await winAcl().userSid(), { dir: isDir })
    if (problem) throw new SecretFileUnsafe(p, problem)
    passed.set(p, key)
  }

  /** Throws SecretFileUnsafe for the directory (and the file, when given) unless both are this user's alone. */
  const check = async (file: string | null): Promise<void> => {
    const chain = pathChain(file ?? dir, a.profileDir)
    const link = symlinkProblem(chain, lstat)
    if (link) throw new SecretFileUnsafe(link.slice(0, link.lastIndexOf(' is a ')), link)
    if (platform === 'win32') {
      await aclCheck(dir, true)
      if (file) await aclCheck(file, false)
      return
    }
    const problem = posixProblem(chain, lstat, a.uid ?? process.getuid?.() ?? -1, file ? 2 : 1)
    if (problem) throw new SecretFileUnsafe(problem.slice(0, problem.indexOf(' ')), problem)
  }

  const read = async (name: string): Promise<string | null> => {
    const file = fileOf(name)
    try {
      await fs.lstat(dir)
    } catch (e) {
      if (missing(e)) return null
      throw e
    }
    try {
      await fs.lstat(file)
    } catch (e) {
      if (!missing(e)) throw e
      await check(null)
      return null
    }
    await check(file)
    return fs.readFile(file, 'utf8')
  }

  /**
   * Makes the store directory already secured. On Windows the ACL is set on a private sibling, which is then renamed
   * into place: a directory made at its real name and secured after would be visible, unprotected, to a second
   * process starting at the same moment (and to anyone else, for that window; X1-12). A rename that loses to another
   * process's leaves that one, which the caller then checks.
   */
  const createDir = async (): Promise<void> => {
    const parent = path.dirname(dir)
    await fs.mkdir(parent, { recursive: true })
    if (platform !== 'win32') {
      await fs.mkdir(dir, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e
      })
      return
    }
    const tmp = path.join(parent, `.${path.basename(dir)}-${randomBytes(6).toString('hex')}`)
    await fs.mkdir(tmp)
    try {
      await winAcl().secureDir(tmp)
      await fs.rename(tmp, dir)
    } catch (e) {
      await fs.rm(tmp, { recursive: true, force: true })
      const exists = await fs.lstat(dir).then(() => true, () => false)
      if (!exists) throw e
    }
  }

  /** Only a directory made here is secured here. One that already existed is checked, never silently tightened. */
  const ensureDir = async (): Promise<void> => {
    try {
      await fs.lstat(dir)
    } catch (e) {
      if (!missing(e)) throw e
      await createDir()
    }
    await check(null)
  }

  const lockFile = path.join(dir, LOCK)
  let swept = false
  /** Locks this store took and could not remove at release (audit U-5). */
  const abandoned = new Set<string>()
  /** A write's temp file older than an hour is one whose process died between creating and renaming it. */
  const sweepTemps = async (): Promise<void> => {
    const names = await fs.readdir(dir).catch(() => [] as string[])
    for (const n of names) {
      if (!n.startsWith(TMP)) continue
      const st = await fs.stat(path.join(dir, n)).catch(() => null)
      if (st && Date.now() - st.mtimeMs > 60 * 60_000) await fs.rm(path.join(dir, n), { force: true }).catch(() => {})
    }
  }
  const guardFile = path.join(dir, BREAK_GUARD)
  const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /**
   * Removes the lock only if it still holds `seen`. Removers take turns through an O_EXCL guard file, and the only way a
   * lock disappears is through here (taking one is O_EXCL on the lock itself), so a remover can never delete a lock
   * that another process took after this one read the old one (Phase 2 review I2). Answers 'busy' when another remover
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
      const now = await fs.readFile(lockFile, 'utf8').catch(() => null)
      if (now !== seen) return 'changed'
      await fs.rm(lockFile, { force: true })
      return 'removed'
    } finally {
      await fs.rm(guardFile, { force: true })
    }
  }

  const takeLock = async (): Promise<() => Promise<void>> => {
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
          // Left behind (audit U-5): this process's next lock would have waited on it as a live holder's. It is known
          // as this process's own, and broken at once.
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
          // by a writer that died is broken by the next caller, not waited on forever (Phase 2 review I3).
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
      if (now() >= deadline) throw new SecretStoreBusy(dir)
      await pause(25)
    }
  }

  /** Windows refuses a rename over a file another process has open for a moment (a lock-free reader, a scanner). */
  const renameRetrying = async (from: string, to: string): Promise<void> => {
    for (let wait = 10; ; wait *= 2) {
      try {
        return await fs.rename(from, to)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if ((code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') || wait > 1280) throw e
        await pause(wait)
      }
    }
  }

  const tx: SecretTx = {
    read,
    write: async (name, text) => {
      const file = fileOf(name)
      // Created exclusively and owner-only inside the already secured directory, so it is never readable by anyone
      // else for even a moment; then made durable and renamed over the old one. A failure leaves no copy behind.
      const tmp = path.join(dir, `${TMP}${randomBytes(8).toString('hex')}`)
      try {
        const h = await fs.open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
        try {
          await h.writeFile(text, 'utf8')
          await h.sync()
        } finally {
          await h.close()
        }
        await renameRetrying(tmp, file)
      } catch (e) {
        await fs.rm(tmp, { force: true })
        throw e
      }
    },
    remove: async (name) => fs.rm(fileOf(name), { force: true }),
    list: async () => (await fs.readdir(dir)).filter((n) => n !== LOCK && !n.startsWith('.'))
  }

  return {
    dir,
    read,
    withLock: async (fn) => {
      await ensureDir()
      const release = await takeLock()
      // Temp files of writes that died with their process, once per store and under the lock (audit U-5).
      if (!swept) {
        swept = true
        await sweepTemps()
      }
      try {
        return await fn(tx)
      } finally {
        await release()
      }
    }
  }
}
