// `astera higgsfield list` and `astera higgsfield use` — answered in the CLI process (higgsfield
// accounts design §3). They read <profile>/higgsfield/accounts.json; `use` only ever runs after the
// person picked an account (hfProxy's out-of-credits message says so). Every real-CLI call goes through
// hfProxy's guarded side call, because the CLI deletes the credentials file on a failed refresh.
import path from 'node:path'
import { readFileSync } from 'node:fs'
import type { CliError } from '../core/orchestration/cliOutput'
import { patchHfAccount, readHfAccounts, resolveHfAccount, setHfCurrent, type HfAccount } from '../core/higgsfield/accounts'
import { BALANCE_KEYS, numberAt } from '../core/higgsfield/credits'
import { findRealHiggsfield, isHiggsfieldCli } from '../core/higgsfield/shims'
import { HfBinaryMissing, realRunner, sideCall, stopOnMissingBinary, type HfRunner } from '../core/higgsfield/runner'

type Outcome = { ok: true; body: Record<string, unknown> } | { ok: false; error: CliError }
/** `needsLogin`: the server said the session expired (the account was marked). `binaryMissing`: the CLI's
 *  own program is gone (the path), so no further status call can work. */
export type StatusSeen = { email?: string; credits: number | null; needsLogin?: true; binaryMissing?: string }
export type StatusRun = (accountId: string) => Promise<StatusSeen | null>
export type HfCliIssue = { kind: 'binaryMissing'; path: string }

/** CLI 1.1.24 on an expired server session: exit 2, `Error: Session expired.` / `Hint: Run: hf auth login`.
 *  The credentials file stays, so only this line tells that the login is gone. */
export const SESSION_EXPIRED = /session expired|run: hf auth login/i

const readOrNull = (p: string): string | null => { try { return readFileSync(p, 'utf8') } catch { return null } }

/** `account status --json` under one account, guarded; null on any other failure or when no CLI is on
 *  PATH. An expired session marks the account needsLogin. */
export function statusRun(profileDir: string, env: NodeJS.ProcessEnv = process.env, runner?: HfRunner): StatusRun {
  return async (id) => {
    try {
      const run = runner ?? (() => {
        const real = findRealHiggsfield({ env, platform: process.platform, skipDirs: [path.join(profileDir, 'orch')], read: readOrNull,
          accept: (f) => isHiggsfieldCli(f, process.platform, { read: readOrNull }) })
        return real === null ? null : realRunner(real, process.platform)
      })()
      if (run === null) return null
      const account = (await readHfAccounts(profileDir)).accounts.find((x) => x.id === id)
      if (!account) return null
      let r
      try {
        r = await sideCall(stopOnMissingBinary(run), ['account', 'status', '--json'], profileDir, env, account)
      } catch (e) {
        if (e instanceof HfBinaryMissing) return { credits: null, binaryMissing: e.path }
        throw e
      }
      if (r.code !== 0) {
        if (!SESSION_EXPIRED.test(r.stderr)) return null
        await patchHfAccount(profileDir, id, { needsLogin: true })
        return { credits: null, needsLogin: true }
      }
      let email: string | undefined
      try {
        const v: unknown = JSON.parse(r.stdout)
        const e = v !== null && typeof v === 'object' ? (v as Record<string, unknown>).email : undefined
        if (typeof e === 'string' && e !== '') email = e
      } catch { /* credits may still parse */ }
      return { email, credits: numberAt(r.stdout, BALANCE_KEYS) }
    } catch {
      return null
    }
  }
}

const invalid = (message: string): Outcome => ({ ok: false, error: { code: 'INVALID_ARGUMENTS', message } })

/** Status of one account (never throws), writing back an email the CLI reported. */
async function look(profileDir: string, account: HfAccount, run: StatusRun) {
  const seen = await run(account.id).catch(() => null)
  if (seen?.email && seen.email !== account.email) {
    await patchHfAccount(profileDir, account.id, { email: seen.email }).catch(() => {})
  }
  return {
    email: seen?.email ?? account.email, credits: seen?.credits ?? null,
    needsLogin: seen?.needsLogin === true, binaryMissing: seen?.binaryMissing
  }
}

export async function higgsfieldCommand(a: {
  cmd: 'higgsfield-list' | 'higgsfield-use'
  args: Record<string, unknown>
  profileDir: string
  run?: StatusRun
}): Promise<Outcome> {
  const run = a.run ?? statusRun(a.profileDir)
  let file
  try {
    file = await readHfAccounts(a.profileDir)
  } catch (err) {
    return { ok: false, error: { code: 'CONFLICT', message: err instanceof Error ? err.message : String(err) } }
  }

  if (a.cmd === 'higgsfield-list') {
    const accounts: Record<string, unknown>[] = []
    let cliIssue: HfCliIssue | null = null
    // One after the other: two token refreshes at once are what makes the CLI delete a login.
    for (const x of file.accounts) {
      // Once the CLI program is known missing no call can answer, so the rest are not asked.
      const seen: Awaited<ReturnType<typeof look>> = x.needsLogin || cliIssue !== null
        ? { email: x.email, credits: null, needsLogin: false, binaryMissing: undefined }
        : await look(a.profileDir, x, run)
      if (seen.binaryMissing) cliIssue = { kind: 'binaryMissing', path: seen.binaryMissing }
      accounts.push({
        id: x.id, label: x.label, ...(seen.email ? { email: seen.email } : {}),
        credits: seen.credits, current: x.id === file.current, needsLogin: x.needsLogin === true || seen.needsLogin
      })
    }
    return { ok: true, body: { current: file.current, accounts, ...(cliIssue ? { cliIssue } : {}) } }
  }

  const key = a.args.account
  if (typeof key !== 'string' || key === '') return invalid('--account needs an id, label or email (see `astera higgsfield list`)')
  const hit = resolveHfAccount(file, key)
  if (hit === 'ambiguous')
    return invalid(`"${key}" matches more than one account; use an id: ${file.accounts.map((x) => x.id).join(', ')}`)
  if (hit === undefined) return { ok: false, error: { code: 'NOT_FOUND', message: `unknown Higgsfield account: ${key}` } }
  if (hit.needsLogin)
    return { ok: false, error: { code: 'CONFLICT', message: `Higgsfield account "${hit.label}" has to log in again: log in again in Astera Settings > Higgsfield` } }
  try {
    await setHfCurrent(a.profileDir, hit.id)
  } catch (err) {
    return { ok: false, error: { code: 'FAILED', message: err instanceof Error ? err.message : String(err) } }
  }
  const seen = await look(a.profileDir, hit, run)
  return { ok: true, body: { current: { id: hit.id, label: hit.label, ...(seen.email ? { email: seen.email } : {}), credits: seen.credits } } }
}
