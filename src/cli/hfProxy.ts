// `astera hf-proxy <args>` — what the higgsfield shims in a session's PATH run (higgsfield accounts
// design §2). Answered in the CLI process: no Host, no app. It runs the real higgsfield CLI under the
// app-wide current account by pointing HIGGSFIELD_CREDENTIALS_PATH/HIGGSFIELD_CONFIG_PATH at that
// account's folder, and guards the one hazard measured on CLI 1.1.24: a failed token refresh deletes
// the credentials file.
import { spawn } from 'node:child_process'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { cliHostTarget } from './host'
import { hfEnvFor, patchHfAccount, readHfAccounts, type HfAccount } from '../core/higgsfield/accounts'
import { findRealHiggsfield } from '../core/higgsfield/shims'
import { windowsSpawn } from '../core/sessions/windowsExecutable'

export interface HfRun { code: number; stdout: string; stderr: string }
/** Runs the real CLI once. `tee`: forward stdout/stderr live to this process while collecting them. */
export type HfRunner = (args: string[], env: NodeJS.ProcessEnv, tee: boolean) => Promise<HfRun>

export function realRunner(file: string, platform: NodeJS.Platform, lead: string[] = []): HfRunner {
  return (args, env, tee) =>
    new Promise((resolve) => {
      const all = [...lead, ...args]
      const cmd = platform === 'win32' ? windowsSpawn(path.win32.basename(file), all, () => file) : { file, args: all }
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
  if (await exists(`${creds}.bak`)) {
    await fs.copyFile(`${creds}.bak`, creds)
    const check = await run(['account', 'status', '--json'], env, false)
    if (check.code === 0 && (await exists(creds))) {
      write('higgsfield: the login was restored from Astera\'s backup; running the command again\n')
      const again = await run(args, env, true)
      if (await exists(creds)) await fs.copyFile(creds, `${creds}.bak`).catch(() => {})
      return again.code
    }
  }
  await patchHfAccount(profileDir, account.id, { needsLogin: true })
  write(`higgsfield: Higgsfield account "${account.label}" has to log in again (Astera Settings > Higgsfield). Tell the user; do not log in yourself.\n`)
  return first.code
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
  const first = await run(a.args, env, true)
  if (await exists(creds)) {
    await fs.copyFile(creds, `${creds}.bak`).catch(() => {})
    return first.code
  }
  return restoreOnce({ run, args: a.args, env, profileDir, account, creds, first, write })
}
