// The Higgsfield Settings tab's main side (higgsfield accounts design §4). `higgsfieldHandlers` is the
// pure part: it takes everything that touches the outside world (the real CLI, the home folder) as
// dependencies so it runs without Electron. `registerHiggsfieldIpc` wires the real ones.
// It imports src/core/higgsfield and src/cli/higgsfield (Electron-free) and nothing from the Host.
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  addHfAccount, hfEnvFor, importHfAccount, patchHfAccount, readHfAccounts, removeHfAccount, setHfCurrent
} from '../core/higgsfield/accounts'
import { findRealHiggsfield, higgsfieldVendorBinary, isHiggsfieldCli } from '../core/higgsfield/shims'
import { backupCredentials, realRunner } from '../core/higgsfield/runner'
import { higgsfieldCommand, statusRun, type HfCliIssue, type StatusRun } from '../cli/higgsfield'

export interface HfListResult {
  current: string | null
  accounts: {
    id: string; label: string; email?: string; credits: number | null; current: boolean; needsLogin: boolean; loggingIn: boolean
  }[]
  cliFound: boolean
  cliIssue: HfCliIssue | null
}
export interface HfLoginResult { ok: boolean; message?: string; reason?: 'cancelled' | 'timeout' }
/** What a login run gets: its stdout as it comes, and a signal that kills the process when aborted. */
export interface LoginIo { onStdout: (chunk: string) => void; signal: AbortSignal }
/** Exit code, or the code with the CLI's last stderr line. Resolves only after the process exited. */
export type LoginRun = (id: string, io: LoginIo) => Promise<number | { code: number; lastError?: string }>

export const LOGIN_TIMEOUT_MS = 3 * 60_000
const VISIT = /visit:\s*(https?:\/\/\S+)/i

/** Feeds `auth login` stdout in; answers the URL of the first complete `visit: <url>` line (CLI 1.1.24
 *  prints `If browser does not open, visit: https://clerk.higgsfield.ai/oauth/authorize?…`), or null. A
 *  line is read only once its newline arrived, so a URL split across chunks is never cut short. */
export function loginUrlReader(): (chunk: string) => string | null {
  let pending = ''
  let url: string | null = null
  return (chunk) => {
    if (url !== null) return url
    pending += chunk
    const nl = pending.lastIndexOf('\n')
    if (nl < 0) return null
    const m = VISIT.exec(pending.slice(0, nl))
    pending = pending.slice(nl + 1)
    if (m) url = m[1]
    return url
  }
}

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
  /** The CLI program missing, found without running it (default: none). */
  cliIssue?: () => HfCliIssue | null
  loginTimeoutMs?: number
}) {
  const { profileDir, home } = deps
  // One handler at a time: two token refreshes on one credentials file make the CLI delete it. A login
  // takes the queue only to start and to finish; while it waits for the browser its account is left
  // out of every status call instead, so the other handlers keep working.
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => {})
    return next
  }
  let listing: Promise<HfListResult> | null = null
  // At most one login at a time: the CLI's loopback callback is one port (localhost:8765).
  let active: { id: string; url: string | null; ctl: AbortController; why: 'cancel' | 'timeout' | null; done: Promise<void> } | null = null
  const refuseWhileLoggingIn = (id: string): void => {
    if (active?.id === id) throw new Error('BUSY: this Higgsfield account is logging in')
  }
  const h = {
    list(): Promise<HfListResult> {
      // Single-flight: a caller arriving while a list runs gets that list (StrictMode's double mount).
      listing ??= serial(async () => {
        const issue = deps.cliIssue?.() ?? null
        // Checked at the moment of each call: an account whose login is running is never asked.
        const run: StatusRun = issue !== null
          ? async () => null
          : (id) => (active?.id === id ? Promise.resolve(null) : deps.runStatus(id))
        const r = await higgsfieldCommand({ cmd: 'higgsfield-list', args: {}, profileDir, run })
        if (!r.ok) throw new Error(r.error.message)
        const body = r.body as {
          current: string | null; accounts: Omit<HfListResult['accounts'][number], 'loggingIn'>[]; cliIssue?: HfCliIssue
        }
        return {
          current: body.current,
          accounts: body.accounts.map((x) => ({ ...x, loggingIn: active?.id === x.id })),
          cliFound: deps.cliFound(),
          cliIssue: issue ?? body.cliIssue ?? null
        }
      }).finally(() => { listing = null })
      return listing
    },
    /** The login running now and the URL it printed, if any. Never runs the CLI. */
    async loginState(): Promise<{ id: string; url: string | null } | null> {
      return active ? { id: active.id, url: active.url } : null
    },
    /** Kills the running login; resolves once it has exited and login() has answered. */
    async cancelLogin(): Promise<void> {
      const a = active
      if (!a) return
      a.why ??= 'cancel'
      a.ctl.abort()
      await a.done
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
    async login(idRaw: unknown): Promise<HfLoginResult> {
      const id = idOf(idRaw)
      if (active) throw new Error(active.id === id ? 'BUSY: this Higgsfield account is logging in' : 'BUSY: another Higgsfield login is running')
      let finished!: () => void
      const me = {
        id, url: null as string | null, ctl: new AbortController(), why: null as 'cancel' | 'timeout' | null,
        done: new Promise<void>((r) => { finished = r })
      }
      active = me
      // Read through a call: cancelLogin and the timer set it while this function awaits.
      const stopped = (): 'cancel' | 'timeout' | null => me.why
      const timeoutMs = deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS
      try {
        // Through the queue: a status call already running on this account ends before the login starts.
        await serial(async () => {
          if (!(await readHfAccounts(profileDir)).accounts.some((a) => a.id === id))
            throw new Error(`unknown higgsfield account: ${id}`)
        })
        if (stopped() === 'cancel') return { ok: false, reason: 'cancelled' }
        const timer = setTimeout(() => { me.why ??= 'timeout'; me.ctl.abort() }, timeoutMs)
        const readUrl = loginUrlReader()
        let out
        try {
          out = await deps.runLogin(id, { signal: me.ctl.signal, onStdout: (chunk) => { me.url = readUrl(chunk) } })
        } finally {
          clearTimeout(timer)
        }
        if (stopped() === 'cancel') return { ok: false, reason: 'cancelled' }
        if (stopped() === 'timeout') return { ok: false, reason: 'timeout', message: `the login did not finish within ${Math.round(timeoutMs / 1000)} s` }
        const { code, lastError } = typeof out === 'number' ? { code: out, lastError: undefined } : out
        return await serial(async (): Promise<HfLoginResult> => {
          const creds = hfEnvFor(profileDir, id).HIGGSFIELD_CREDENTIALS_PATH
          if (code !== 0) return { ok: false, message: lastError || `higgsfield auth login exited with ${code}` }
          if (!(await validCredentials(creds))) return { ok: false, message: lastError || 'the login finished but left no credentials' }
          await backupCredentials(creds)
          await patchHfAccount(profileDir, id, { needsLogin: false })
          // Still marked as logging in here, so no list asks this account at the same time.
          const seen = await deps.runStatus(id).catch(() => null)
          if (seen?.email) await patchHfAccount(profileDir, id, { email: seen.email })
          return { ok: true }
        })
      } finally {
        active = null
        finished()
      }
    },
    async remove(idRaw: unknown): Promise<void> {
      const id = idOf(idRaw)
      refuseWhileLoggingIn(id)
      return serial(async () => { refuseWhileLoggingIn(id); await removeHfAccount(profileDir, id) })
    },
    async setCurrent(idRaw: unknown): Promise<void> {
      const id = idOf(idRaw)
      return serial(() => setHfCurrent(profileDir, id))
    }
  }
  return h
}

const readOrNull = (p: string): string | null => { try { return readFileSync(p, 'utf8') } catch { return null } }

/** What the npm launcher adds to the environment of the program it starts (bin/run.js, CLI 1.1.24). */
function launcherEnv(binary: string): Record<string, string> {
  let pm: unknown
  try { pm = (JSON.parse(readFileSync(path.join(path.dirname(binary), 'install.json'), 'utf8')) as { package_manager?: unknown }).package_manager } catch { /* none */ }
  return { HIGGSFIELD_INSTALL_METHOD: 'npm', HIGGSFIELD_PACKAGE_MANAGER: typeof pm === 'string' && pm !== '' ? pm : 'npm' }
}

/** Production wiring: the real CLI found on PATH (Astera's own `<profile>/orch` shims skipped). */
export function registerHiggsfieldIpc(
  ipcMain: { handle: (channel: string, fn: (e: unknown, ...a: unknown[]) => unknown) => void },
  profileDir: string,
  home: string
): void {
  const findReal = (): string | null =>
    findRealHiggsfield({ env: process.env, platform: process.platform, skipDirs: [path.join(profileDir, 'orch')], read: readOrNull,
      accept: (f) => isHiggsfieldCli(f, process.platform, { read: readOrNull }) })
  const vendorOf = (real: string) => higgsfieldVendorBinary(real, process.platform, { read: readOrNull })
  const cliIssue = (): HfCliIssue | null => {
    const real = findReal()
    if (real === null) return null
    const v = vendorOf(real)
    return v.missing && v.binary !== null ? { kind: 'binaryMissing', path: v.binary } : null
  }
  const runLogin: LoginRun = async (id, io) => {
    const real = findReal()
    if (real === null) return { code: 127, lastError: 'the higgsfield CLI was not found on PATH' }
    const v = vendorOf(real)
    if (v.missing) return { code: 127, lastError: `the Higgsfield CLI program is missing (${v.binary})` }
    // The program itself when its path is known: the node launcher does not pass a kill on to it (it is
    // a grandchild), so a cancelled login would keep running and hold the callback port.
    const run = realRunner(v.binary ?? real, process.platform, [], {
      // Hidden: the CLI opens the browser itself, and a blank console for minutes is worse than none.
      hide: true,
      stdin: 'ignore',
      signal: io.signal,
      onStdout: io.onStdout
    })
    const env = { ...process.env, ...(v.binary !== null ? launcherEnv(v.binary) : {}), ...hfEnvFor(profileDir, id) }
    const r = await run(['auth', 'login'], env, false)
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
    profileDir, home, cliFound: () => findReal() !== null, runStatus, runLogin, cliIssue
  })
  ipcMain.handle('higgsfield.list', () => h.list())
  ipcMain.handle('higgsfield.add', (_e, label) => h.add(label))
  ipcMain.handle('higgsfield.importCurrent', (_e, label) => h.importCurrent(label))
  ipcMain.handle('higgsfield.login', (_e, id) => h.login(id))
  ipcMain.handle('higgsfield.loginState', () => h.loginState())
  ipcMain.handle('higgsfield.cancelLogin', () => h.cancelLogin())
  ipcMain.handle('higgsfield.remove', (_e, id) => h.remove(id))
  ipcMain.handle('higgsfield.setCurrent', (_e, id) => h.setCurrent(id))
}
