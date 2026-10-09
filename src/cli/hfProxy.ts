// `astera hf-proxy <args>` — what the higgsfield shims in a session's PATH run (higgsfield accounts
// design §2). Answered in the CLI process: no Host, no app. It runs the real higgsfield CLI under the
// app-wide current account by pointing HIGGSFIELD_CREDENTIALS_PATH/HIGGSFIELD_CONFIG_PATH at that
// account's folder, and guards the one hazard measured on CLI 1.1.24: a failed token refresh deletes
// the credentials file.
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { cliHostTarget } from './host'
import { hfEnvFor, patchHfAccount, readHfAccounts, type HfAccount } from '../core/higgsfield/accounts'
import { findRealHiggsfield, higgsfieldVendorBinary, isHiggsfieldCli } from '../core/higgsfield/shims'
import {
  BALANCE_KEYS, COST_KEYS, costArgsFor, expiredLoginMessage, isBalanceQuery, isGenerateJob, subIndex, looksOutOfCredits, numberAt,
  otherAccountsLine, SESSION_EXPIRED, shortCreditsMessage, type OtherAccount
} from '../core/higgsfield/credits'
import { NO_WORKSPACE, noWorkspaceText } from '../core/higgsfield/display'
import { downloadAsset, firstMediaUrl, foreignIds, readLedger, recordAfter, recordJobFile, type HfAssetLedger } from '../core/higgsfield/assets'
import {
  backupCredentials, copyBack, exists, guardCredentials, HfBinaryMissing, passThrough, readOrNull, realRunner, sideCall, stopOnMissingBinary,
  type HfRun, type HfRunner
} from '../core/higgsfield/runner'
import { SIDE_CALL_TIMEOUT_MS } from '../core/higgsfield/runner'

// Kept importable from here: the runner and guard live in core/higgsfield/runner (the app uses them too).
export { backupCredentials, guardCredentials, realRunner, sideCall }
export type { HfRun, HfRunner }

/** What the agent is told when the CLI's own program is gone (Windows Defender quarantined hf.exe once).
 *  Reinstalling would only bring back a file the antivirus removes again; the person decides. */
export const binaryMissingMessage = (p: string): string =>
  `higgsfield: the Higgsfield CLI program is missing (${p}). On Windows, antivirus may have quarantined it: ask the user to check Windows Security > Protection history. Tell the user; do not reinstall it yourself.\n`

/** The runner to use; or an exit code: 127 (after saying so) when nothing is found on PATH or the
 *  package's program is gone, or the code of a program that is not the Higgsfield CLI (Hugging Face's
 *  `hf`), which runs untouched. */
async function pickRunner(
  a: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; run?: HfRunner }, as: string | undefined, args: string[],
  orchDir: string, write: (s: string) => void
): Promise<HfRunner | number> {
  if (a.run) return a.run
  const real = findRealHiggsfield({ env: a.env, platform: a.platform, skipDirs: [orchDir], read: readOrNull, prefer: as })
  if (real === null) {
    write(`${as ?? 'higgsfield'}: the higgsfield CLI was not found on PATH (Astera's own folder ${orchDir} was skipped)\n`)
    return 127
  }
  if (!isHiggsfieldCli(real, a.platform, { read: readOrNull })) return passThrough(real, a.platform, args, a.env)
  const vendor = higgsfieldVendorBinary(real, a.platform, { read: readOrNull })
  if (vendor.missing && vendor.binary !== null) {
    write(binaryMissingMessage(vendor.binary))
    return 127
  }
  return realRunner(real, a.platform)
}

/** `--as=<name>` (the name the shim was invoked by) leads the shim's arguments; the rest belong to the CLI. */
export function splitAs(args: string[]): { as?: string; args: string[] } {
  const m = /^--as=(.+)$/.exec(args[0] ?? '')
  return m ? { as: m[1], args: args.slice(1) } : { args }
}

/** The current account, or undefined (running without one) when none is set or the file is unreadable. */
async function currentAccount(profileDir: string, write: (s: string) => void): Promise<HfAccount | undefined> {
  try {
    const f = await readHfAccounts(profileDir)
    return f.accounts.find((x) => x.id === f.current)
  } catch (err) {
    write(`higgsfield: Astera's higgsfield/accounts.json could not be read (${String(err)}); running without an account\n`)
    return undefined
  }
}

const loginAgain = (account: HfAccount) =>
  `higgsfield: Higgsfield account "${account.label}" has to log in again (Astera Settings > Creative Hub > Higgsfield). Tell the user; do not log in yourself.\n`

/** A command that may have created something billed or stored before it failed: a job, or an upload. */
const mayHaveCreated = (args: string[]): boolean => {
  const i = subIndex(args)
  return isGenerateJob(args) || (args[i] === 'upload' && args[i + 1] === 'create')
}

const notRerun = (args: string[]) => {
  const what = isGenerateJob(args) ? 'job' : 'upload'
  const check = what === 'job'
    ? '`higgsfield generate get <id>` or the job list'
    : 'the upload list'
  return `higgsfield: the Higgsfield login was restored from Astera's backup, but the command was not run again: the ${what} may already have been created. Check with ${check} before retrying.\n`
}

/**
 * The CLI deleted the credentials file (failed refresh). Restore the backup once (spec §1), check with
 * `account status`, and rerun the command if the login holds; otherwise mark the account needsLogin.
 * A job or an upload is never rerun: it may already exist, and a second run would charge again.
 */
export async function restoreOnce(a: {
  run: HfRunner; args: string[]; env: NodeJS.ProcessEnv; profileDir: string; account: HfAccount
  creds: string; first: HfRun; write: (s: string) => void
}): Promise<number> {
  const { run, args, env, profileDir, account, creds, first, write } = a
  const noRerun = mayHaveCreated(args)
  try {
    if (await exists(`${creds}.bak`)) {
      await copyBack(creds)
      const check = await run(['account', 'status', '--json'], env, false, { timeoutMs: SIDE_CALL_TIMEOUT_MS })
      if (check.code === 0 && (await exists(creds))) {
        if (noRerun) {
          await backupCredentials(creds)
          write(notRerun(args))
          return first.code
        }
        write("higgsfield: the login was restored from Astera's backup; running the command again\n")
        const again = await run(args, env, true)
        await backupCredentials(creds)
        return again.code
      }
    }
    if (!(await exists(creds)) && (await exists(`${creds}.bak`))) await copyBack(creds)
    await patchHfAccount(profileDir, account.id, { needsLogin: true })
  } catch (e) {
    if (e instanceof HfBinaryMissing) throw e
    // fall through to the message: the agent gets the instruction, not a stack trace
  }
  write(loginAgain(account))
  return first.code
}


async function accountCredits(run: HfRunner, profileDir: string, base: NodeJS.ProcessEnv, account: HfAccount): Promise<Pick<OtherAccount, 'credits' | 'state'>> {
  const r = await sideCall(run, ['account', 'status', '--json'], profileDir, base, account)
  if (r.code === 0) return { credits: numberAt(r.stdout, BALANCE_KEYS) }
  return NO_WORKSPACE.test(r.stderr) ? { credits: null, state: 'needsWorkspace' } : { credits: null }
}

/** The accounts other than the current one, each with its credits (one guarded status call at a time).
 *  An account that needs a login is left out, or with `withUnusable` listed without a call. */
async function otherAccounts(
  run: HfRunner, profileDir: string, base: NodeJS.ProcessEnv, current: HfAccount, withUnusable = false
): Promise<OtherAccount[]> {
  const file = await readHfAccounts(profileDir).catch(() => null)
  const out: OtherAccount[] = []
  for (const o of (file?.accounts ?? []).filter((x) => x.id !== current.id && (withUnusable || !x.needsLogin))) {
    if (o.needsLogin) { out.push({ label: o.label, email: o.email, credits: null, state: 'needsLogin' }); continue }
    const seen = await accountCredits(run, profileDir, base, o).catch((e: unknown) => {
      if (e instanceof HfBinaryMissing) throw e
      return { credits: null } as const
    })
    out.push({ label: o.label, email: o.email, ...seen })
  }
  return out
}

/**
 * Swap every upload/job id that belongs to another account for a local file the CLI will upload itself.
 * An upload becomes its recorded path; a job's first media file is downloaded once (the job is read under
 * its own account, through the guarded side call). Any failure leaves that id as it was, with one line.
 */
async function bringIdsOver(a: {
  run: HfRunner; args: string[]; profileDir: string; base: NodeJS.ProcessEnv; account: HfAccount
  doFetch: typeof fetch; downloadTimeoutMs?: number; write: (s: string) => void
}): Promise<string[]> {
  const { run, profileDir, base, account, doFetch, downloadTimeoutMs, write } = a
  const args = [...a.args]
  let ledger: HfAssetLedger
  let accounts: HfAccount[] = []
  try {
    ledger = await readLedger(profileDir)
    if (!foreignIds(args, ledger, account.id).length) return args
    accounts = (await readHfAccounts(profileDir)).accounts
  } catch {
    return args
  }
  for (const f of foreignIds(args, ledger, account.id)) {
    const upload = ledger.uploads[f.id]
    const ownerId = (upload ?? ledger.jobs[f.id]).account
    const label = accounts.find((x) => x.id === ownerId)?.label ?? ownerId
    try {
      let file: string | undefined
      if (upload) {
        if (await exists(upload.path)) file = upload.path
      } else {
        const job = ledger.jobs[f.id]
        if (job.file && (await exists(job.file))) file = job.file
        else {
          const owner = accounts.find((x) => x.id === ownerId)
          if (!owner) throw new Error('unknown account')
          const got = await sideCall(run, ['generate', 'get', f.id, '--json'], profileDir, base, owner)
          const url = got.code === 0 ? firstMediaUrl(got.stdout) : null
          if (!url) throw new Error('no media url')
          file = await downloadAsset(profileDir, f.id, url, doFetch, { timeoutMs: downloadTimeoutMs })
          // The file is here either way: a ledger that could not be locked or written only costs the next run a
          // download again (final review M3).
          await recordJobFile(profileDir, f.id, file).catch(() => {})
        }
      }
      if (!file) throw new Error('no file')
      args[f.index] = f.prefix + file
    } catch (e) {
      if (e instanceof HfBinaryMissing) throw e
      write(`higgsfield: could not bring ${f.id} over from account "${label}"; passing it through
`)
    }
  }
  return args
}

/** Runs `generate cost` and `account status` under the current account, then guards its credentials once. */
async function preCheck(run: HfRunner, env: NodeJS.ProcessEnv, args: string[], g: { profileDir: string; account: HfAccount; creds: string }) {
  // One after the other, never together: two token refreshes on the same credentials can rotate the
  // refresh token under each other and make the CLI delete the file.
  const status = await run(['account', 'status', '--json'], env, false, { timeoutMs: SIDE_CALL_TIMEOUT_MS })
  const cost = await run(costArgsFor(args), env, false)
  const loginLost = await guardCredentials({ run, env, ...g })
  return {
    loginLost, code: status.code !== 0 ? status.code : cost.code !== 0 ? cost.code : 1,
    need: cost.code === 0 ? numberAt(cost.stdout, COST_KEYS) : null,
    have: status.code === 0 ? numberAt(status.stdout, BALANCE_KEYS) : null
  }
}

export async function hfProxy(a: {
  args: string[]
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  run?: HfRunner
  write?: (s: string) => void
  fetch?: typeof fetch
  /** How long a download of another account's job may take (default 120 s). */
  downloadTimeoutMs?: number
}): Promise<number> {
  const write = a.write ?? ((s: string) => process.stderr.write(s))
  try {
    return await proxy(a, write)
  } catch (e) {
    // The launcher said its program is gone: no account is marked and no login file touched.
    if (!(e instanceof HfBinaryMissing)) throw e
    write(binaryMissingMessage(e.path))
    return 127
  }
}

async function proxy(a: Parameters<typeof hfProxy>[0], write: (s: string) => void): Promise<number> {
  const { profileDir } = cliHostTarget({ env: a.env, platform: a.platform, home: a.home })
  const { as, args: given } = splitAs(a.args)
  const picked = await pickRunner(a, as, given, path.join(profileDir, 'orch'), write)
  if (typeof picked === 'number') return picked
  const run = stopOnMissingBinary(picked)
  const account = await currentAccount(profileDir, write)
  if (!account) return (await run(given, a.env, true)).code

  const env = { ...a.env, ...hfEnvFor(profileDir, account.id) }
  const creds = env.HIGGSFIELD_CREDENTIALS_PATH as string
  // Ids of another account become files before the pre-check, so it prices the same args the job runs.
  const args = await bringIdsOver({ run, args: given, profileDir, base: a.env, account, doFetch: a.fetch ?? fetch, downloadTimeoutMs: a.downloadTimeoutMs, write })
  if (isGenerateJob(args) && !args.includes('-h') && !args.includes('--help')) {
    const { need, have, loginLost, code } = await preCheck(run, env, args, { profileDir, account, creds })
    if (loginLost) { write(loginAgain(account)); return code }
    if (need !== null && have !== null && need > have) {
      write(shortCreditsMessage({
        current: { label: account.label, email: account.email, credits: have }, need,
        others: await otherAccounts(run, profileDir, a.env, account)
      }))
      return 75   // EX_TEMPFAIL: nothing was created
    }
  }
  const first = await run(args, env, true)
  // A fresh login has no workspace: every call fails until the person picks one (Settings > Creative Hub > Higgsfield).
  if (first.code !== 0 && NO_WORKSPACE.test(first.stderr)) write(`higgsfield: ${noWorkspaceText(account.label)}\n`)
  if (first.code === 0) await recordAfter(profileDir, account.id, args, first.stdout).catch(() => {})
  // The session was rejected by the server while the file is still there: nothing is restored or rerun.
  // A missing file is a failed refresh, and falls through to the restore below.
  if (first.code !== 0 && given[0] !== 'auth' && SESSION_EXPIRED.test(first.stderr) && (await exists(creds))) {
    await patchHfAccount(profileDir, account.id, { needsLogin: true }).catch(() => {})
    write(expiredLoginMessage(account.label))
    return first.code
  }
  // A balance query never says other accounts exist: one stderr line does (stdout stays the CLI's own).
  if (first.code === 0 && isBalanceQuery(args)) {
    const others = await otherAccounts(run, profileDir, a.env, account, true)
    if (others.length) write(otherAccountsLine(others))
  }
  if (isGenerateJob(args) && first.code !== 0 && looksOutOfCredits(first.stdout + first.stderr)) {
    await guardCredentials({ run, env, profileDir, account, creds })
    write(shortCreditsMessage({
      current: { label: account.label, email: account.email, credits: null }, need: null,
      others: await otherAccounts(run, profileDir, a.env, account)
    }))
    return first.code
  }
  if (await exists(creds)) {
    await backupCredentials(creds)
    return first.code
  }
  // `auth login` / `auth logout` change the file on purpose; a missing file after them is not a failure.
  if (given[0] === 'auth') {
    if (given[1] === 'logout') await fs.rm(`${creds}.bak`, { force: true }).catch(() => {})
    return first.code
  }
  return restoreOnce({ run, args, env, profileDir, account, creds, first, write })
}
