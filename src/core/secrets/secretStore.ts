// Owner-only secret files (remote runtime design §4.6, D5, X1-12). One backend in v1: files in a directory only this
// user can open, checked on every read, written only under a directory lock with a re-read inside it, so two
// processes never lose each other's update. Used by the Host (identity, client records) and by controllers (runtime
// profiles and tokens). Nothing falls back to an unchecked read.
import { constants, lstatSync, promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { pidLives as realPidLives } from '../host/pidFile'
import { takeFileLock } from '../fileLock'
import { pathChain, posixProblem, symlinkProblem, widenedAbove, type StatLike } from './posixCheck'
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

const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT'

/**
 * Drops group and other write from a folder above a store (issue #8), through a handle that refuses a symlink and
 * anything but a folder, and only when the folder it opened is this user's (final review I1): a folder swapped for a
 * symlink after the look is never followed, and the mode comes from the folder it changes, so nothing is ever given a
 * bit it did not have. The sticky and setgid bits stay (M2).
 */
export async function tightenDir(p: string, uid: number): Promise<void> {
  const h = await fs.open(p, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  try {
    const st = await h.stat()
    if (!st.isDirectory() || st.uid !== uid) return
    await h.chmod(st.mode & 0o7777 & ~0o022)
  } finally {
    await h.close()
  }
}

export function openSecretStore(a: {
  dir: string
  profileDir: string
  platform?: NodeJS.Platform
  acl?: WinAcl
  lstat?: (p: string) => StatLike
  uid?: number
  /** Test seam for `tightenDir`. */
  tighten?: (p: string, uid: number) => Promise<void>
  lockWaitMs?: number
  staleMs?: number
  now?: () => number
  pidLives?: (pid: number) => boolean
}): SecretStore {
  const dir = path.resolve(a.dir)
  const platform = a.platform ?? process.platform
  const lstat = a.lstat ?? ((p: string): StatLike => lstatSync(p))
  const tighten = a.tighten ?? tightenDir
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
    const uid = a.uid ?? process.getuid?.() ?? -1
    // The folders above the store lose group and other write before they are judged (issue #8): Ubuntu's default umask
    // 002 makes every folder another process creates 775, and a store made or left under one was refused for good, on
    // every read too (final review C2). One that cannot be changed is left for the check to refuse with its reason (M1).
    for (const p of widenedAbove(pathChain(dir, a.profileDir), lstat, uid, 1)) await tighten(p, uid).catch(() => {})
    const problem = posixProblem(chain, lstat, uid, file ? 2 : 1)
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
    if (platform !== 'win32') {
      // No group or other write on the folders made here (issue #8); ones another process made under a group-writable
      // umask are tightened by the check that follows.
      await fs.mkdir(parent, { recursive: true, mode: 0o755 })
      await fs.mkdir(dir, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e
      })
      return
    }
    await fs.mkdir(parent, { recursive: true })
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

  /** Only a store directory made here is secured here. One that already existed is checked, never silently tightened;
   *  the folders above it are tightened by every check (issue #8). */
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

  // The lock itself lives in fileLock.ts, shared with other files several processes write.
  const takeLock = (): Promise<() => Promise<void>> =>
    takeFileLock({ lockFile, guardFile, waitMs, staleMs, now, pidLives: lives, busy: () => new SecretStoreBusy(dir) })

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
