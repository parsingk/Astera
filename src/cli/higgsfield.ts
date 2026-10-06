// `astera higgsfield list` and `astera higgsfield use` — answered in the CLI process (higgsfield
// accounts design §3). They read <profile>/higgsfield/accounts.json; `use` only ever runs after the
// person picked an account (hfProxy's out-of-credits message says so). Every real-CLI call goes through
// hfProxy's guarded side call, because the CLI deletes the credentials file on a failed refresh.
import path from 'node:path'
import { readFileSync } from 'node:fs'
import type { CliError } from '../core/orchestration/cliOutput'
import { patchHfAccount, readHfAccounts, resolveHfAccount, setHfCurrent, type HfAccount } from '../core/higgsfield/accounts'
import { BALANCE_KEYS, numberAt, SESSION_EXPIRED } from '../core/higgsfield/credits'
import { findRealHiggsfield, isHiggsfieldCli } from '../core/higgsfield/shims'
import { HfBinaryMissing, realRunner, sideCall, stopOnMissingBinary, type HfRun, type HfRunner } from '../core/higgsfield/runner'
import { NO_WORKSPACE, noWorkspaceText, type HfWorkspace } from '../core/higgsfield/display'

type Outcome = { ok: true; body: Record<string, unknown> } | { ok: false; error: CliError }
/** `needsLogin`: the server said the session expired (the account was marked). `binaryMissing`: the CLI's
 *  own program is gone (the path), so no further status call can work. `needsWorkspace`: logged in, but
 *  no workspace is selected (not stored: picking one fixes it); `workspaces` are the ones to pick from. */
export type StatusSeen = {
  email?: string; credits: number | null; needsLogin?: true; binaryMissing?: string
  needsWorkspace?: true; workspaces?: HfWorkspace[]
}
/** One guarded real-CLI call under an account; null when no CLI is on PATH or the account is unknown.
 *  Throws HfBinaryMissing when the CLI's program is gone. */
export type AccountRun = (accountId: string, args: string[]) => Promise<HfRun | null>
export type StatusRun = (accountId: string) => Promise<StatusSeen | null>
export type HfCliIssue = { kind: 'binaryMissing'; path: string }


const readOrNull = (p: string): string | null => { try { return readFileSync(p, 'utf8') } catch { return null } }

export function accountRun(profileDir: string, env: NodeJS.ProcessEnv = process.env, runner?: HfRunner): AccountRun {
  return async (id, args) => {
    const run = runner ?? (() => {
      const real = findRealHiggsfield({ env, platform: process.platform, skipDirs: [path.join(profileDir, 'orch')], read: readOrNull,
        accept: (f) => isHiggsfieldCli(f, process.platform, { read: readOrNull }) })
      return real === null ? null : realRunner(real, process.platform)
    })()
    if (run === null) return null
    const account = (await readHfAccounts(profileDir)).accounts.find((x) => x.id === id)
    if (!account) return null
    return sideCall(stopOnMissingBinary(run), args, profileDir, env, account)
  }
}

/** `workspace list --json` (CLI 1.1.24): `[{ id, name, plan_type, credits, is_selected, user_role }]`, name
 *  possibly null. null when it is not that shape; entries without an id are dropped. */
export function parseWorkspaces(stdout: string): (HfWorkspace & { selected: boolean })[] | null {
  let v: unknown
  try { v = JSON.parse(stdout) } catch { return null }
  if (!Array.isArray(v)) return null
  const str = (x: unknown) => (typeof x === 'string' && x !== '' ? x : null)
  const num = (x: unknown) => {
    const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN
    return Number.isFinite(n) ? n : null
  }
  return v.flatMap((w) => {
    if (typeof w !== 'object' || w === null) return []
    const o = w as Record<string, unknown>
    const id = str(o.id)
    if (id === null) return []
    return [{ id, name: str(o.name), plan: str(o.plan_type), credits: num(o.credits), selected: o.is_selected === true }]
  })
}

/** The account's workspaces through a guarded call, or null. */
export async function listWorkspaces(run: AccountRun, id: string): Promise<(HfWorkspace & { selected: boolean })[] | null> {
  const r = await run(id, ['workspace', 'list', '--json'])
  return r !== null && r.code === 0 ? parseWorkspaces(r.stdout) : null
}

/** `account status --json` under one account, guarded; null on any other failure or when no CLI is on
 *  PATH. An expired session marks the account needsLogin; no workspace selected answers needsWorkspace
 *  with the account's workspaces. */
export function statusRun(profileDir: string, env: NodeJS.ProcessEnv = process.env, runner?: HfRunner): StatusRun {
  const run = accountRun(profileDir, env, runner)
  return async (id) => {
    try {
      let r
      let workspaces
      try {
        r = await run(id, ['account', 'status', '--json'])
        // One after the other on the same account, never together (token refresh).
        if (r !== null && r.code !== 0 && NO_WORKSPACE.test(r.stderr)) workspaces = await listWorkspaces(run, id)
      } catch (e) {
        if (e instanceof HfBinaryMissing) return { credits: null, binaryMissing: e.path }
        throw e
      }
      if (r === null) return null
      if (r.code !== 0) {
        if (NO_WORKSPACE.test(r.stderr)) {
          return { credits: null, needsWorkspace: true, workspaces: (workspaces ?? []).map(({ id: wid, name, plan, credits }) => ({ id: wid, name, plan, credits })) }
        }
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
    needsLogin: seen?.needsLogin === true, binaryMissing: seen?.binaryMissing,
    needsWorkspace: seen?.needsWorkspace === true, workspaces: seen?.workspaces
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
        ? { email: x.email, credits: null, needsLogin: false, binaryMissing: undefined, needsWorkspace: false, workspaces: undefined }
        : await look(a.profileDir, x, run)
      if (seen.binaryMissing) cliIssue = { kind: 'binaryMissing', path: seen.binaryMissing }
      accounts.push({
        id: x.id, label: x.label, ...(seen.email ? { email: seen.email } : {}),
        credits: seen.credits, current: x.id === file.current, needsLogin: x.needsLogin === true || seen.needsLogin,
        needsWorkspace: seen.needsWorkspace, ...(seen.needsWorkspace ? { workspaces: seen.workspaces ?? [] } : {})
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
  // Switched either way (it is logged in); the agent learns the workspace is missing before it runs a job.
  const workspace = seen.needsWorkspace ? { needsWorkspace: true, warning: noWorkspaceText(hit.label) } : {}
  return { ok: true, body: { current: { id: hit.id, label: hit.label, ...(seen.email ? { email: seen.email } : {}), credits: seen.credits, ...workspace } } }
}
