// Higgsfield accounts Astera keeps (higgsfield accounts design §1). One folder per account under
// <profile>/higgsfield/<id>/ holds that account's credentials.json and config.json; the CLI is always
// run with HIGGSFIELD_CREDENTIALS_PATH and HIGGSFIELD_CONFIG_PATH pointing there. `current` is one
// value for the whole app (D3).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { renameRetrying } from '../renameRetry'
import { withFileLock } from '../fileLock'

export interface HfAccount { id: string; label: string; email?: string; needsLogin?: boolean }
export interface HfAccountsFile { accounts: HfAccount[]; current: string | null }

export const hfRoot = (profileDir: string): string => path.join(profileDir, 'higgsfield')
export const hfAccountDir = (profileDir: string, id: string): string => path.join(hfRoot(profileDir), id)
const fileOf = (profileDir: string): string => path.join(hfRoot(profileDir), 'accounts.json')

/** Every read-then-write of a file under higgsfield/ holds this (audit U-8): the app, the CLI and hf-proxy write them
 *  from different processes, and each wrote the whole file it read, so a change made meanwhile was lost. */
export const hfLocked = <T>(profileDir: string, fn: () => Promise<T>): Promise<T> => withFileLock(hfRoot(profileDir), fn)

export const hfEnvFor = (profileDir: string, id: string) => ({
  HIGGSFIELD_CREDENTIALS_PATH: path.join(hfAccountDir(profileDir, id), 'credentials.json'),
  HIGGSFIELD_CONFIG_PATH: path.join(hfAccountDir(profileDir, id), 'config.json')
})

function narrow(raw: unknown): HfAccountsFile {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { accounts?: unknown }).accounts))
    throw new Error('higgsfield/accounts.json is not an accounts file')
  const accounts = (raw as { accounts: unknown[] }).accounts.flatMap((a): HfAccount[] => {
    if (typeof a !== 'object' || a === null) return []
    const { id, label, email, needsLogin } = a as Record<string, unknown>
    if (typeof id !== 'string' || typeof label !== 'string') return []
    return [{ id, label, ...(typeof email === 'string' ? { email } : {}), ...(needsLogin === true ? { needsLogin: true } : {}) }]
  })
  const cur = (raw as { current?: unknown }).current
  const current = typeof cur === 'string' && accounts.some((a) => a.id === cur) ? cur : null
  return { accounts, current }
}

export async function readHfAccounts(profileDir: string): Promise<HfAccountsFile> {
  let text: string
  try {
    text = await fs.readFile(fileOf(profileDir), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { accounts: [], current: null }
    throw err
  }
  return narrow(JSON.parse(text))
}

export async function writeHfAccounts(profileDir: string, f: HfAccountsFile): Promise<void> {
  const file = fileOf(profileDir)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(f, null, 2), 'utf8')
    await renameRetrying(tmp, file)
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}

export function resolveHfAccount(f: HfAccountsFile, key: string): HfAccount | 'ambiguous' | undefined {
  const byId = f.accounts.find((a) => a.id === key)
  if (byId) return byId
  const k = key.toLowerCase()
  for (const field of ['label', 'email'] as const) {
    const hits = f.accounts.filter((a) => a[field]?.toLowerCase() === k)
    if (hits.length > 1) return 'ambiguous'
    if (hits.length === 1) return hits[0]
  }
  return undefined
}

const append = (profileDir: string, label: string, fill: (dir: string) => Promise<void>): Promise<HfAccount> =>
  hfLocked(profileDir, () => appendLocked(profileDir, label, fill))

async function appendLocked(profileDir: string, label: string, fill: (dir: string) => Promise<void>): Promise<HfAccount> {
  const f = await readHfAccounts(profileDir)
  const account: HfAccount = { id: randomUUID().slice(0, 8), label }
  const dir = hfAccountDir(profileDir, account.id)
  await fs.mkdir(dir, { recursive: true })
  try {
    await fill(dir)
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true })
    throw err
  }
  await writeHfAccounts(profileDir, { accounts: [...f.accounts, account], current: f.current ?? account.id })
  return account
}

export const addHfAccount = (profileDir: string, label: string): Promise<HfAccount> => append(profileDir, label, async () => {})

/** Copies, never moves (spec §1): the login outside Astera stays where it was. */
export const importHfAccount = (profileDir: string, label: string, sourceDir: string): Promise<HfAccount> =>
  append(profileDir, label, async (dir) => {
    const creds = path.join(sourceDir, 'credentials.json')
    try {
      await fs.copyFile(creds, path.join(dir, 'credentials.json'))
    } catch {
      throw new Error(`no credentials.json in ${sourceDir}`)
    }
    await fs.copyFile(path.join(sourceDir, 'config.json'), path.join(dir, 'config.json')).catch(() => {})
  })

export async function removeHfAccount(profileDir: string, id: string): Promise<void> {
  await hfLocked(profileDir, async () => {
    const f = await readHfAccounts(profileDir)
    // Before any fs.rm: an id like '..' or '' must never reach a path join.
    if (!f.accounts.some((a) => a.id === id)) throw new Error(`unknown higgsfield account: ${id}`)
    const accounts = f.accounts.filter((a) => a.id !== id)
    // D2: Astera never picks an account the person did not pick, so removing the current one leaves none.
    const current = f.current === id ? null : f.current
    await writeHfAccounts(profileDir, { accounts, current })
  })
  await fs.rm(hfAccountDir(profileDir, id), { recursive: true, force: true })
}

export const setHfCurrent = (profileDir: string, id: string): Promise<void> =>
  hfLocked(profileDir, async () => {
    const f = await readHfAccounts(profileDir)
    if (!f.accounts.some((a) => a.id === id)) throw new Error(`unknown higgsfield account: ${id}`)
    await writeHfAccounts(profileDir, { ...f, current: id })
  })

export const patchHfAccount = (
  profileDir: string,
  id: string,
  patch: Partial<Pick<HfAccount, 'email' | 'needsLogin' | 'label'>>
): Promise<void> =>
  hfLocked(profileDir, async () => {
    const f = await readHfAccounts(profileDir)
    const accounts = f.accounts.map((a) => {
      if (a.id !== id) return a
      const next: HfAccount = { ...a, ...patch }
      if (!next.needsLogin) delete next.needsLogin
      return next
    })
    await writeHfAccounts(profileDir, { ...f, accounts })
  })
