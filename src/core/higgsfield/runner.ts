// The real higgsfield CLI runner and the credential guard, shared by the CLI (`astera hf-proxy`,
// `astera higgsfield`) and the app's Settings tab. Electron-free on purpose: src/main imports it.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { renameRetrying } from '../renameRetry'
import { cmdRefusal } from '../install/mcpClients'
import { hfEnvFor, patchHfAccount, type HfAccount } from './accounts'
import { npmShimTarget } from './shims'
import { windowsSpawn } from '../sessions/windowsExecutable'

export interface HfRun { code: number; stdout: string; stderr: string }
/** Runs the real CLI once. `tee`: forward stdout/stderr live to this process while collecting them. */
export type HfRunner = (args: string[], env: NodeJS.ProcessEnv, tee: boolean) => Promise<HfRun>

export interface RealRunnerOptions {
  /** false shows the console window of a Windows child (an interactive login). Default true. */
  hide?: boolean
  /** Kill the child after this long and report code 1. */
  timeoutMs?: number
  onStdout?: (chunk: string) => void
  /** The child's stdin. Default 'inherit' (the proxy passes the agent's stdin through). */
  stdin?: 'inherit' | 'ignore'
}

/** How to start `file` with `args`: on win32 an npm `.cmd` becomes node on its script (so no cmd.exe reads
 *  the agent's words), any other `.cmd`/`.bat` goes through cmd.exe only when no argument is cmd syntax. */
function commandFor(file: string, platform: NodeJS.Platform, args: string[], env: NodeJS.ProcessEnv):
  { file: string; args: string[]; env: NodeJS.ProcessEnv } | { refusal: string } {
  if (platform !== 'win32') return { file, args, env }
  const ext = path.win32.extname(file).toLowerCase()
  const shim = ext === '.cmd' || ext === '.bat' ? npmShimTarget(file, readOrNull, { env }) : null
  if (shim) return { file: shim.node, args: [shim.script, ...args], env: shim.electronAsNode ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env }
  const refusal = cmdRefusal(file, args, platform)
  if (refusal !== null) return { refusal }
  return { ...windowsSpawn(path.win32.basename(file), args, () => file), env }
}

/** Runs `file` exactly as typed: the environment it was given, stdio inherited, its exit code. For a
 *  program found under a Higgsfield name that is not the Higgsfield CLI (Hugging Face's `hf`). */
export function passThrough(file: string, platform: NodeJS.Platform, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const cmd = commandFor(file, platform, args, env)
    if ('refusal' in cmd) {
      process.stderr.write(`${path.basename(file)}: ${cmd.refusal}\n`)
      resolve(2)
      return
    }
    const child = spawn(cmd.file, cmd.args, { env: cmd.env, stdio: 'inherit' })
    child.on('error', (e) => { process.stderr.write(`${String(e)}\n`); resolve(127) })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

export function realRunner(file: string, platform: NodeJS.Platform, lead: string[] = [], opts: RealRunnerOptions = {}): HfRunner {
  return (args, env, tee) =>
    new Promise((resolve) => {
      const cmd = commandFor(file, platform, [...lead, ...args], env)
      if ('refusal' in cmd) {
        const msg = `higgsfield: ${cmd.refusal}\n`
        if (tee) process.stderr.write(msg)
        resolve({ code: 2, stdout: '', stderr: msg })
        return
      }
      const child = spawn(cmd.file, cmd.args, { env: cmd.env, stdio: [opts.stdin ?? 'inherit', 'pipe', 'pipe'], windowsHide: opts.hide ?? true })
      let stdout = ''
      let stderr = ''
      let timer: NodeJS.Timeout | undefined
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          stderr += '\nhiggsfield: timed out'
          child.kill()
        }, opts.timeoutMs)
      }
      child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); opts.onStdout?.(b.toString('utf8')); if (tee) process.stdout.write(b) })
      child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); if (tee) process.stderr.write(b) })
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: stderr + String(e) }) })
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }) })
    })
}

export const exists = (p: string) => fs.stat(p).then(() => true, () => false)
export const readOrNull = (p: string): string | null => { try { return readFileSync(p, 'utf8') } catch { return null } }

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

/** Copy `.bak` to the credentials file without overwriting: a file another process just wrote wins. */
export async function copyBack(creds: string): Promise<void> {
  try {
    await fs.copyFile(`${creds}.bak`, creds, fs.constants.COPYFILE_EXCL)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
}

/**
 * After any side call (pre-check, other accounts' status): keep the backup fresh when the credentials
 * are there; when the CLI deleted them, copy the backup back (no rerun) and confirm with `account status`.
 * A failed confirmation marks the account needsLogin; the file is copied back again either way, so no
 * call leaves an account's credentials deleted. Never throws.
 */
export async function guardCredentials(a: {
  run: HfRunner; env: NodeJS.ProcessEnv; profileDir: string; account: HfAccount; creds: string
}): Promise<boolean> {
  const { run, env, profileDir, account, creds } = a
  try {
    if (await exists(creds)) { await backupCredentials(creds); return false }
    if (!(await exists(`${creds}.bak`))) return false
    await copyBack(creds)
    const check = await run(['account', 'status', '--json'], env, false)
    if (check.code === 0 && (await exists(creds))) { await backupCredentials(creds); return false }
    if (!(await exists(creds))) await copyBack(creds)
    await patchHfAccount(profileDir, account.id, { needsLogin: true })
    return true
  } catch {
    return false   // best effort
  }
}

/** One side call under `account`, guarded. */
export async function sideCall(run: HfRunner, args: string[], profileDir: string, base: NodeJS.ProcessEnv, account: HfAccount): Promise<HfRun> {
  const env = { ...base, ...hfEnvFor(profileDir, account.id) }
  const r = await run(args, env, false)
  await guardCredentials({ run, env, profileDir, account, creds: env.HIGGSFIELD_CREDENTIALS_PATH as string })
  return r
}
