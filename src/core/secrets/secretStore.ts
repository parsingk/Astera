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

  const takeLock = async (): Promise<() => Promise<void>> => {
    const lockFile = path.join(dir, LOCK)
    const mine = JSON.stringify({ pid: process.pid, startedAt: now(), nonce: randomBytes(8).toString('hex') })
    const deadline = now() + waitMs
    let emptySince: number | null = null
    for (;;) {
      try {
        const h = await fs.open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
        try {
          await h.writeFile(mine)
        } finally {
          await h.close()
        }
        return async () => {
          const held = await fs.readFile(lockFile, 'utf8').catch(() => null)
          if (held === mine) await fs.rm(lockFile, { force: true })
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
      const held = await fs.readFile(lockFile, 'utf8').catch(() => null)
      if (held === null) continue
      let stale: boolean
      if (held === '') {
        // Its writer may be between creating it and filling it: wait, and break it only once it has stayed empty.
        emptySince ??= now()
        stale = now() - emptySince > staleMs
      } else {
        emptySince = null
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
      if (stale) {
        await fs.rm(lockFile, { force: true })
        continue
      }
      if (now() >= deadline) throw new SecretStoreBusy(dir)
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  const tx: SecretTx = {
    read,
    write: async (name, text) => {
      const file = fileOf(name)
      // Created exclusively and owner-only inside the already secured directory, so it is never readable by anyone
      // else for even a moment; then made durable and renamed over the old one.
      const tmp = path.join(dir, `${TMP}${randomBytes(8).toString('hex')}`)
      const h = await fs.open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      try {
        await h.writeFile(text, 'utf8')
        await h.sync()
      } finally {
        await h.close()
      }
      await fs.rename(tmp, file)
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
      try {
        return await fn(tx)
      } finally {
        await release()
      }
    }
  }
}
