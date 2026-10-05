// `astera hf-proxy <args>` — what the higgsfield shims in a session's PATH run (higgsfield accounts
// design §2). Answered in the CLI process: no Host, no app. It runs the real higgsfield CLI under the
// app-wide current account by pointing HIGGSFIELD_CREDENTIALS_PATH/HIGGSFIELD_CONFIG_PATH at that
// account's folder, and guards the one hazard measured on CLI 1.1.24: a failed token refresh deletes
// the credentials file.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { renameRetrying } from '../core/renameRetry'
import { cmdRefusal } from '../core/install/mcpClients'
import { cliHostTarget } from './host'
import { hfEnvFor, patchHfAccount, readHfAccounts, type HfAccount } from '../core/higgsfield/accounts'
import { findRealHiggsfield, npmShimTarget } from '../core/higgsfield/shims'
import { BALANCE_KEYS, COST_KEYS, costArgsFor, isGenerateJob, looksOutOfCredits, numberAt, shortCreditsMessage } from '../core/higgsfield/credits'
import { windowsSpawn } from '../core/sessions/windowsExecutable'

export interface HfRun { code: number; stdout: string; stderr: string }
/** Runs the real CLI once. `tee`: forward stdout/stderr live to this process while collecting them. */
export type HfRunner = (args: string[], env: NodeJS.ProcessEnv, tee: boolean) => Promise<HfRun>

export function realRunner(file: string, platform: NodeJS.Platform, lead: string[] = []): HfRunner {
  return (args, env, tee) =>
    new Promise((resolve) => {
      let all = [...lead, ...args]
      let cmd: { file: string; args: string[] } = { file, args: all }
      if (platform === 'win32') {
        const ext = path.win32.extname(file).toLowerCase()
        const shim = ext === '.cmd' || ext === '.bat' ? npmShimTarget(file, readOrNull, { env }) : null
        if (shim) {
          // npm's own shim: run node on its script, so no cmd.exe reads the agent's words.
          all = [shim.script, ...all]
          cmd = { file: shim.node, args: all }
          if (shim.electronAsNode) env = { ...env, ELECTRON_RUN_AS_NODE: '1' }
        } else {
          const refusal = cmdRefusal(file, all, platform)
          if (refusal !== null) {
            const msg = `higgsfield: ${refusal}
`
            if (tee) process.stderr.write(msg)
            resolve({ code: 2, stdout: '', stderr: msg })
            return
          }
          cmd = windowsSpawn(path.win32.basename(file), all, () => file)
        }
      }
      const child = spawn(cmd.file, cmd.args, { env, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); if (tee) process.stdout.write(b) })
      child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); if (tee) process.stderr.write(b) })
      child.on('error', (e) => resolve({ code: 127, stdout, stderr: stderr + String(e) }))
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    })
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false)
const readOrNull = (p: string): string | null => { try { return readFileSync(p, 'utf8') } catch { return null } }

/** Refresh `<creds>.bak` from the credentials file, but only from one that parses to a non-empty
 *  object, and atomically: a half-written file (the CLI mid-write, a concurrent session) must never
 *  replace the only good backup. Never throws. */
export async function backupCredentials(creds: string): Promise<void> {
  const tmp = `${creds}.bak.${randomBytes(4).toString('hex')}.tmp`
  try {
    const text = await fs.readFile(creds, 'utf8')
    const v: unknown = JSON.parse(text)
    if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.keys(v).length === 0) return
    await fs.writeFile(tmp, text)
    await renameRetrying(tmp, `${creds}.bak`)
  } catch {
    // unreadable or not JSON: keep the backup we have
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}

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
      await fs.copyFile(`${creds}.bak`, creds)
      const check = await run(['account', 'status', '--json'], env, false)
      if (check.code === 0 && (await exists(creds))) {
        write("higgsfield: the login was restored from Astera's backup; running the command again\n")
        const again = await run(args, env, true)
        await backupCredentials(creds)
        return again.code
      }
    }
    if (!(await exists(creds)) && (await exists(`${creds}.bak`))) await fs.copyFile(`${creds}.bak`, creds)
    await patchHfAccount(profileDir, account.id, { needsLogin: true })
  } catch {
    // fall through to the message: the agent gets the instruction, not a stack trace
  }
  write(`higgsfield: Higgsfield account "${account.label}" has to log in again (Astera Settings > Higgsfield). Tell the user; do not log in yourself.
`)
  return first.code
}

/**
 * After any side call (pre-check, other accounts' status): keep the backup fresh when the credentials
 * are there; when the CLI deleted them, copy the backup back (no rerun) and confirm with `account status`.
 * A failed confirmation marks the account needsLogin; the file is copied back again either way, so no
 * call leaves an account's credentials deleted. Never throws.
 */
export async function guardCredentials(a: {
  run: HfRunner; env: NodeJS.ProcessEnv; profileDir: string; account: HfAccount; creds: string
}): Promise<void> {
  const { run, env, profileDir, account, creds } = a
  try {
    if (await exists(creds)) { await backupCredentials(creds); return }
    if (!(await exists(`${creds}.bak`))) return
    await fs.copyFile(`${creds}.bak`, creds)
    const check = await run(['account', 'status', '--json'], env, false)
    if (check.code === 0 && (await exists(creds))) { await backupCredentials(creds); return }
    if (!(await exists(creds))) await fs.copyFile(`${creds}.bak`, creds)
    await patchHfAccount(profileDir, account.id, { needsLogin: true })
  } catch {
    // best effort
  }
}

/** One side call under `account`, guarded. */
async function sideCall(run: HfRunner, args: string[], profileDir: string, base: NodeJS.ProcessEnv, account: HfAccount): Promise<HfRun> {
  const env = { ...base, ...hfEnvFor(profileDir, account.id) }
  const r = await run(args, env, false)
  await guardCredentials({ run, env, profileDir, account, creds: env.HIGGSFIELD_CREDENTIALS_PATH as string })
  return r
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

/** Runs `generate cost` and `account status` under the current account, then guards its credentials once. */
async function preCheck(run: HfRunner, env: NodeJS.ProcessEnv, args: string[], g: { profileDir: string; account: HfAccount; creds: string }) {
  const [cost, status] = await Promise.all([run(costArgsFor(args), env, false), run(['account', 'status', '--json'], env, false)])
  await guardCredentials({ run, env, ...g })
  return {
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
}): Promise<number> {
  const write = a.write ?? ((s: string) => process.stderr.write(s))
  const { profileDir } = cliHostTarget({ env: a.env, platform: a.platform, home: a.home })
  const run = pickRunner(a, path.join(profileDir, 'orch'), write)
  if (!run) return 127
  const account = await currentAccount(profileDir, write)
  if (!account) return (await run(a.args, a.env, true)).code

  const env = { ...a.env, ...hfEnvFor(profileDir, account.id) }
  const creds = env.HIGGSFIELD_CREDENTIALS_PATH as string
  // Task 6 rewrites local ids/paths in `a.args` here, before the pre-check, so it prices the same args the job runs.
  const args = a.args
  if (isGenerateJob(args)) {
    const { need, have } = await preCheck(run, env, args, { profileDir, account, creds })
    if (need !== null && have !== null && need > have) {
      write(shortCreditsMessage({
        current: { label: account.label, email: account.email, credits: have }, need,
        others: await otherAccounts(run, profileDir, a.env, account)
      }))
      return 75   // EX_TEMPFAIL: nothing was created
    }
  }
  const first = await run(args, env, true)
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
