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
import { killProcessTree } from '../run/kill'

export interface HfRun { code: number; stdout: string; stderr: string }
/** Runs the real CLI once. `tee`: forward stdout/stderr live to this process while collecting them. */
/** `o.timeoutMs`: end the run once it has taken this long (audit U-7); the side calls give one. */
export type HfRunner = (args: string[], env: NodeJS.ProcessEnv, tee: boolean, o?: { timeoutMs?: number }) => Promise<HfRun>

/** How long a side call (a status, another account's credits, a generation's state) may take (audit U-7). */
export const SIDE_CALL_TIMEOUT_MS = 30_000

export interface RealRunnerOptions {
  /** false shows the console window of a Windows child (an interactive login). Default true. */
  hide?: boolean
  onStdout?: (chunk: string) => void
  /** The child's stdin. Default 'inherit' (the proxy passes the agent's stdin through). */
  stdin?: 'inherit' | 'ignore'
  /** Aborting kills the child this runner started (that process only; nothing found by name). The run
   *  answers once it exited. Already aborted: nothing is started. */
  signal?: AbortSignal
  /** After the kill, answer (code 1) even without an exit once this long has passed, so a cancel can
   *  never hang on a process that will not die. Default 5000. */
  killGraceMs?: number
  /** For tests: a fake child process. */
  spawn?: typeof spawn
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
  return (args, env, tee, ro = {}) =>
    new Promise((resolve) => {
      const cmd = commandFor(file, platform, [...lead, ...args], env)
      if ('refusal' in cmd) {
        const msg = `higgsfield: ${cmd.refusal}\n`
        if (tee) process.stderr.write(msg)
        resolve({ code: 2, stdout: '', stderr: msg })
        return
      }
      if (opts.signal?.aborted) {
        resolve({ code: 1, stdout: '', stderr: 'higgsfield: cancelled' })
        return
      }
      const child = (opts.spawn ?? spawn)(cmd.file, cmd.args, { env: cmd.env, stdio: [opts.stdin ?? 'inherit', 'pipe', 'pipe'], windowsHide: opts.hide ?? true })
      let stdout = ''
      let stderr = ''
      let settled = false
      let grace: NodeJS.Timeout | undefined
      const onAbort = (): void => {
        stderr += '\nhiggsfield: cancelled'
        // The whole tree (final review M-8), as the time limit's kill.
        killProcessTree(child)
        // After a kill, the exit is the answer: a process the child started may still hold the pipes open.
        child.once('exit', (code) => finish(code))
        grace = setTimeout(() => finish(1, '\nhiggsfield: the process did not exit after the kill'), opts.killGraceMs ?? 5000)
      }
      // A time limit ends it the way a cancel does (audit U-7), with the whole tree on Windows.
      const limit =
        ro.timeoutMs !== undefined
          ? setTimeout(() => {
              stderr += `\nhiggsfield: did not finish within ${Math.round((ro.timeoutMs as number) / 1000)} s`
              killProcessTree(child)
              child.once('exit', (code) => finish(code ?? 1))
              grace = setTimeout(() => finish(1, '\nhiggsfield: the process did not exit after the kill'), opts.killGraceMs ?? 5000)
            }, ro.timeoutMs)
          : undefined
      const finish = (code: number | null, extra = ''): void => {
        if (settled) return
        settled = true
        clearTimeout(grace)
        clearTimeout(limit)
        opts.signal?.removeEventListener('abort', onAbort)
        resolve({ code: code ?? 1, stdout, stderr: stderr + extra })
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); opts.onStdout?.(b.toString('utf8')); if (tee) process.stdout.write(b) })
      child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); if (tee) process.stderr.write(b) })
      child.on('error', (e) => finish(127, String(e)))
      child.on('close', (code) => finish(code))
    })
}

/** The program path from the npm launcher's `binary not found at <path>. Reinstall: …` (exit != 0), or
 *  null. The launcher prints it when `<pkg>/vendor/hf(.exe)` is gone (quarantined by antivirus). */
export function binaryMissingIn(r: HfRun): string | null {
  if (r.code === 0) return null
  const m = /binary not found at (.+?)(?:\.\s+Reinstall\b.*)?\s*$/im.exec(r.stderr)
  return m ? m[1].trim() : null
}

/** Thrown by a runner wrapped with `stopOnMissingBinary` once the CLI program is known to be gone. */
export class HfBinaryMissing extends Error {
  constructor(readonly path: string) { super(`the Higgsfield CLI program is missing (${path})`) }
}

/** Throws HfBinaryMissing for a run that reports the program gone, and for every call after it (nothing
 *  more is started). The guards rethrow it, so no login file is restored and no account marked. */
export function stopOnMissingBinary(run: HfRunner): HfRunner {
  let missing: string | null = null
  return async (args, env, tee, o) => {
    if (missing !== null) throw new HfBinaryMissing(missing)
    // The time limit passes through (final review I-3): dropped here, hf-proxy's side calls had none.
    const r = await run(args, env, tee, o)
    missing = binaryMissingIn(r)
    if (missing !== null) throw new HfBinaryMissing(missing)
    return r
  }
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
 * call leaves an account's credentials deleted. Never throws, except HfBinaryMissing from its runner.
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
  } catch (e) {
    if (e instanceof HfBinaryMissing) throw e
    return false   // best effort
  }
}

/** One side call under `account`, guarded. */
export async function sideCall(run: HfRunner, args: string[], profileDir: string, base: NodeJS.ProcessEnv, account: HfAccount): Promise<HfRun> {
  const env = { ...base, ...hfEnvFor(profileDir, account.id) }
  const r = await run(args, env, false, { timeoutMs: SIDE_CALL_TIMEOUT_MS })
  await guardCredentials({ run, env, profileDir, account, creds: env.HIGGSFIELD_CREDENTIALS_PATH as string })
  return r
}
