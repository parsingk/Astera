// The Higgsfield Settings tab's main side (higgsfield accounts design §4). `higgsfieldHandlers` is the
// pure part: it takes everything that touches the outside world (the real CLI, the home folder) as
// dependencies so it runs without Electron. `registerHiggsfieldIpc` wires the real ones.
// It imports src/core/higgsfield and src/cli/higgsfield (Electron-free) and nothing from the Host.
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  addHfAccount, hfEnvFor, importHfAccount, patchHfAccount, readHfAccounts, removeHfAccount, setHfCurrent
} from '../core/higgsfield/accounts'
import { findRealHiggsfield, isHiggsfieldCli } from '../core/higgsfield/shims'
import { backupCredentials, realRunner } from '../core/higgsfield/runner'
import { higgsfieldCommand, statusRun, type StatusRun } from '../cli/higgsfield'

export interface HfListResult {
  current: string | null
  accounts: { id: string; label: string; email?: string; credits: number | null; current: boolean; needsLogin: boolean }[]
  cliFound: boolean
}
/** Exit code, or the code with the CLI's last stderr line. */
export type LoginRun = (id: string) => Promise<number | { code: number; lastError?: string }>

const ID = /^[A-Za-z0-9_-]{1,64}$/
function idOf(v: unknown): string {
  if (typeof v !== 'string' || !ID.test(v)) throw new Error('INVALID: account id')
  return v
}
function labelOf(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > 200) throw new Error('INVALID: label must be a non-empty string')
  return v.trim()
}

async function validCredentials(file: string): Promise<boolean> {
  try {
    const v: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length > 0
  } catch {
    return false
  }
}

export function higgsfieldHandlers(deps: {
  profileDir: string
  home: string
  cliFound: () => boolean
  runStatus: StatusRun
  runLogin: LoginRun
}) {
  const { profileDir, home } = deps
  // One handler at a time: two token refreshes on one credentials file make the CLI delete it.
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => {})
    return next
  }
  let listing: Promise<HfListResult> | null = null
  const h = {
    list(): Promise<HfListResult> {
      // Single-flight: a caller arriving while a list runs gets that list (StrictMode's double mount).
      listing ??= serial(async () => {
        const r = await higgsfieldCommand({ cmd: 'higgsfield-list', args: {}, profileDir, run: deps.runStatus })
        if (!r.ok) throw new Error(r.error.message)
        return { ...(r.body as Omit<HfListResult, 'cliFound'>), cliFound: deps.cliFound() }
      }).finally(() => { listing = null })
      return listing
    },
    async add(label: unknown): Promise<{ id: string }> {
      const name = labelOf(label)
      return serial(async () => ({ id: (await addHfAccount(profileDir, name)).id }))
    },
    async importCurrent(label: unknown): Promise<{ id: string }> {
      const name = labelOf(label)
      return serial(async () => {
        const account = await importHfAccount(profileDir, name, path.join(home, '.config', 'higgsfield'))
        const creds = hfEnvFor(profileDir, account.id).HIGGSFIELD_CREDENTIALS_PATH
        if (!(await validCredentials(creds))) {
          await removeHfAccount(profileDir, account.id)
          throw new Error('INVALID: the login file being imported is incomplete; try again')
        }
        await backupCredentials(creds)
        return { id: account.id }
      })
    },
    async login(idRaw: unknown): Promise<{ ok: boolean; message?: string }> {
      const id = idOf(idRaw)
      return serial(async () => {
        if (!(await readHfAccounts(profileDir)).accounts.some((a) => a.id === id))
          throw new Error(`unknown higgsfield account: ${id}`)
        const out = await deps.runLogin(id)
        const { code, lastError } = typeof out === 'number' ? { code: out, lastError: undefined } : out
        const creds = hfEnvFor(profileDir, id).HIGGSFIELD_CREDENTIALS_PATH
        if (code !== 0) return { ok: false, message: lastError || `higgsfield auth login exited with ${code}` }
        if (!(await validCredentials(creds))) return { ok: false, message: lastError || 'the login finished but left no credentials' }
        await backupCredentials(creds)
        await patchHfAccount(profileDir, id, { needsLogin: false })
        const seen = await deps.runStatus(id).catch(() => null)
        if (seen?.email) await patchHfAccount(profileDir, id, { email: seen.email })
        return { ok: true }
      })
    },
    async remove(idRaw: unknown): Promise<void> {
      const id = idOf(idRaw)
      return serial(() => removeHfAccount(profileDir, id))
    },
    async setCurrent(idRaw: unknown): Promise<void> {
      const id = idOf(idRaw)
      return serial(() => setHfCurrent(profileDir, id))
    }
  }
  return h
}

const readOrNull = (p: string): string | null => { try { return readFileSync(p, 'utf8') } catch { return null } }
const URL_RE = /https:\/\/[^\s"'<>]+/

/** Production wiring: the real CLI found on PATH (Astera's own `<profile>/orch` shims skipped). */
export function registerHiggsfieldIpc(
  ipcMain: { handle: (channel: string, fn: (e: unknown, ...a: unknown[]) => unknown) => void },
  profileDir: string,
  home: string,
  openExternal: (url: string) => Promise<void> | void
): void {
  const findReal = (): string | null =>
    findRealHiggsfield({ env: process.env, platform: process.platform, skipDirs: [path.join(profileDir, 'orch')], read: readOrNull,
      accept: (f) => isHiggsfieldCli(f, process.platform, { read: readOrNull }) })
  const runLogin: LoginRun = async (id) => {
    const real = findReal()
    if (real === null) return { code: 127, lastError: 'the higgsfield CLI was not found on PATH' }
    let opened = false
    let pending = ''
    const run = realRunner(real, process.platform, [], {
      // Hidden: the CLI opens the browser itself, and a blank console for minutes is worse than none.
      hide: true,
      stdin: 'ignore',
      timeoutMs: 5 * 60_000,
      // Fallback when the CLI prints the URL instead. Matched per complete line, so a URL split across
      // chunks is never opened truncated.
      onStdout: (chunk) => {
        if (opened) return
        pending += chunk
        const nl = pending.lastIndexOf('\n')
        if (nl < 0) return
        const m = URL_RE.exec(pending.slice(0, nl))
        pending = pending.slice(nl + 1)
        if (m) { opened = true; void Promise.resolve(openExternal(m[0])).catch(() => {}) }
      }
    })
    const r = await run(['auth', 'login'], { ...process.env, ...hfEnvFor(profileDir, id) }, false)
    const lastError = r.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()
    return { code: r.code, lastError }
  }
  // No stdin for the status calls either: nothing may wait on a terminal that is not there.
  const runStatus: StatusRun = async (id) => {
    const real = findReal()
    if (real === null) return null
    return statusRun(profileDir, process.env, realRunner(real, process.platform, [], { stdin: 'ignore' }))(id)
  }
  const h = higgsfieldHandlers({
    profileDir, home, cliFound: () => findReal() !== null, runStatus, runLogin
  })
  ipcMain.handle('higgsfield.list', () => h.list())
  ipcMain.handle('higgsfield.add', (_e, label) => h.add(label))
  ipcMain.handle('higgsfield.importCurrent', (_e, label) => h.importCurrent(label))
  ipcMain.handle('higgsfield.login', (_e, id) => h.login(id))
  ipcMain.handle('higgsfield.remove', (_e, id) => h.remove(id))
  ipcMain.handle('higgsfield.setCurrent', (_e, id) => h.setCurrent(id))
}
