// `astera hf-proxy <args>` — what the higgsfield shims in a session's PATH run (higgsfield accounts
// design §2). Answered in the CLI process: no Host, no app. It runs the real higgsfield CLI under the
// app-wide current account by pointing HIGGSFIELD_CREDENTIALS_PATH/HIGGSFIELD_CONFIG_PATH at that
// account's folder, and guards the one hazard measured on CLI 1.1.24: a failed token refresh deletes
// the credentials file.
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { cliHostTarget } from './host'
import { hfEnvFor, patchHfAccount, readHfAccounts, type HfAccount } from '../core/higgsfield/accounts'
import { findRealHiggsfield } from '../core/higgsfield/shims'
import { BALANCE_KEYS, COST_KEYS, costArgsFor, isGenerateJob, looksOutOfCredits, numberAt, shortCreditsMessage } from '../core/higgsfield/credits'
import { downloadAsset, firstMediaUrl, foreignIds, readLedger, recordAfter, recordJobFile, type HfAssetLedger } from '../core/higgsfield/assets'
import { backupCredentials, copyBack, exists, guardCredentials, readOrNull, realRunner, sideCall, type HfRun, type HfRunner } from '../core/higgsfield/runner'

// Kept importable from here: the runner and guard live in core/higgsfield/runner (the app uses them too).
export { backupCredentials, guardCredentials, realRunner, sideCall }
export type { HfRun, HfRunner }

/** The runner to use, or null (after saying so) when no real higgsfield CLI is on PATH. */
function pickRunner(a: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; run?: HfRunner }, orchDir: string, write: (s: string) => void): HfRunner | null {
  if (a.run) return a.run
  const real = findRealHiggsfield({ env: a.env, platform: a.platform, skipDirs: [orchDir], read: readOrNull })
  if (real === null) {
    write(`higgsfield: the higgsfield CLI was not found on PATH (Astera's own folder ${orchDir} was skipped)\n`)
    return null
  }
  return realRunner(real, a.platform)
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
  `higgsfield: Higgsfield account "${account.label}" has to log in again (Astera Settings > Higgsfield). Tell the user; do not log in yourself.\n`

/**
 * The CLI deleted the credentials file (failed refresh). Restore the backup once (spec §1), check with
 * `account status`, and rerun the command if the login holds; otherwise mark the account needsLogin.
 */
export async function restoreOnce(a: {
  run: HfRunner; args: string[]; env: NodeJS.ProcessEnv; profileDir: string; account: HfAccount
  creds: string; first: HfRun; write: (s: string) => void
}): Promise<number> {
  const { run, args, env, profileDir, account, creds, first, write } = a
  try {
    if (await exists(`${creds}.bak`)) {
      await copyBack(creds)
      const check = await run(['account', 'status', '--json'], env, false)
      if (check.code === 0 && (await exists(creds))) {
        write("higgsfield: the login was restored from Astera's backup; running the command again\n")
        const again = await run(args, env, true)
        await backupCredentials(creds)
        return again.code
      }
    }
    if (!(await exists(creds)) && (await exists(`${creds}.bak`))) await copyBack(creds)
    await patchHfAccount(profileDir, account.id, { needsLogin: true })
  } catch {
    // fall through to the message: the agent gets the instruction, not a stack trace
  }
  write(loginAgain(account))
  return first.code
}


async function accountCredits(run: HfRunner, profileDir: string, base: NodeJS.ProcessEnv, account: HfAccount): Promise<number | null> {
  const r = await sideCall(run, ['account', 'status', '--json'], profileDir, base, account)
  return r.code === 0 ? numberAt(r.stdout, BALANCE_KEYS) : null
}

async function otherAccounts(run: HfRunner, profileDir: string, base: NodeJS.ProcessEnv, current: HfAccount) {
  const file = await readHfAccounts(profileDir).catch(() => null)
  const others = (file?.accounts ?? []).filter((x) => x.id !== current.id && !x.needsLogin)
  return Promise.all(others.map(async (o) => ({
    label: o.label, email: o.email, credits: await accountCredits(run, profileDir, base, o).catch(() => null)
  })))
}

/**
 * Swap every upload/job id that belongs to another account for a local file the CLI will upload itself.
 * An upload becomes its recorded path; a job's first media file is downloaded once (the job is read under
 * its own account, through the guarded side call). Any failure leaves that id as it was, with one line.
 */
async function bringIdsOver(a: {
  run: HfRunner; args: string[]; profileDir: string; base: NodeJS.ProcessEnv; account: HfAccount
  doFetch: typeof fetch; write: (s: string) => void
}): Promise<string[]> {
  const { run, profileDir, base, account, doFetch, write } = a
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
          file = await downloadAsset(profileDir, f.id, url, doFetch)
          await recordJobFile(profileDir, f.id, file)
        }
      }
      if (!file) throw new Error('no file')
      args[f.index] = f.prefix + file
    } catch {
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
  const status = await run(['account', 'status', '--json'], env, false)
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
}): Promise<number> {
  const write = a.write ?? ((s: string) => process.stderr.write(s))
  const { profileDir } = cliHostTarget({ env: a.env, platform: a.platform, home: a.home })
  const run = pickRunner(a, path.join(profileDir, 'orch'), write)
  if (!run) return 127
  const account = await currentAccount(profileDir, write)
  if (!account) return (await run(a.args, a.env, true)).code

  const env = { ...a.env, ...hfEnvFor(profileDir, account.id) }
  const creds = env.HIGGSFIELD_CREDENTIALS_PATH as string
  // Ids of another account become files before the pre-check, so it prices the same args the job runs.
  const args = await bringIdsOver({ run, args: a.args, profileDir, base: a.env, account, doFetch: a.fetch ?? fetch, write })
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
  if (first.code === 0) await recordAfter(profileDir, account.id, args, first.stdout).catch(() => {})
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
  if (a.args[0] === 'auth') {
    if (a.args[1] === 'logout') await fs.rm(`${creds}.bak`, { force: true }).catch(() => {})
    return first.code
  }
  return restoreOnce({ run, args, env, profileDir, account, creds, first, write })
}
