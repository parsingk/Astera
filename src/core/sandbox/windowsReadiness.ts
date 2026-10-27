// Whether a Codex home's elevated Windows sandbox is set up (sandbox design §10 item 1), as Task 2 measured and ruled it
// (inventory §23.3). A sandboxed Codex session on a home that is not set up would start Codex's own setup at its first
// command, and with it Windows' administrator prompt, in front of nobody; so a start asks first, and refuses one that is
// not ready (`SANDBOX_UNAVAILABLE: windows-setup codex <account>`), which the app offers to set up (설정하기).
//
// Asking never brings up the prompt itself. `codex doctor --json` reads the setup without running it; only a home it
// calls complete is then given the echo through the sandbox, which on a home with no setup would start the setup. A home
// doctor calls complete can still be stale: each elevated setup gives the machine's two sandbox users new passwords and
// keeps them in the home it set up only (from Codex's source, not measured), and doctor compares versions only. Its echo
// then fails, and it reads not set up.
import { execFile } from 'node:child_process'
import { windowsSpawn } from '../sessions/windowsExecutable'

export type Readiness = 'ready' | 'not-set-up'

/** Runs codex with `argv`, `env` laid over the environment the caller's session would start with. `out` is stdout (where
 *  doctor writes its report), `err` stderr; `code` is null when codex did not exit by itself (not found, timed out). */
export type CodexRun = (argv: string[], env: Record<string, string | undefined>) => Promise<{ code: number | null; out: string; err?: string }>

export const DOCTOR_ARGV = ['-c', 'windows.sandbox="elevated"', 'doctor', '--json']
export const READY_MARKER = 'ASTERA_SANDBOX_OK'
export const READY_ARGV = ['sandbox', '-c', 'windows.sandbox="elevated"', '--', 'cmd.exe', '/d', '/c', 'echo', READY_MARKER]
/** The setup Task 2 measured, for the home in CODEX_HOME. It brings up Windows' administrator prompt, and writes
 *  `windows.sandbox = "elevated"` into that home's config.toml. */
export const SETUP_ARGV = ['sandbox', 'setup', '--elevated', '--current-user']

/** doctor answered in 0.5 to 12 s and the echo in about 1 s (Task 2); past this a home reads not set up. */
export const READINESS_RUN_MS = 30_000
/** The setup waits on a person at the administrator prompt. */
export const SETUP_RUN_MS = 5 * 60_000

/** The answers asked in this process, by CODEX_HOME (the ambient account's, with none, under ''). Only a ready one stays:
 *  see `codexWindowsReadiness`. */
const answers = new Map<string, Promise<Readiness>>()
const keyOf = (codexHome: string | null): string => codexHome ?? ''
const homeEnv = (codexHome: string | null): Record<string, string> => (codexHome === null ? {} : { CODEX_HOME: codexHome })

/** `checks["sandbox.helpers"].details["sandbox provisioning"]` of doctor's report, or null when the report does not read
 *  or says nothing about it. Anything codex printed around the JSON is left aside. */
export function provisioningOf(out: string): string | null {
  const parsed = parseReport(out)
  const helpers = (parsed as { checks?: Record<string, { details?: Record<string, unknown> } | undefined> } | null)?.checks?.['sandbox.helpers']
  const v = helpers?.details?.['sandbox provisioning']
  return typeof v === 'string' ? v : null
}

function parseReport(out: string): unknown {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  const whole = tryParse(out.trim())
  if (whole !== null) return whole
  const from = out.indexOf('{')
  const to = out.lastIndexOf('}')
  return from >= 0 && to > from ? tryParse(out.slice(from, to + 1)) : null
}

async function ask(a: { codexHome: string | null; run: CodexRun }): Promise<Readiness> {
  const env = homeEnv(a.codexHome)
  try {
    const doctor = await a.run(DOCTOR_ARGV, env)
    // Not the exit code: doctor exits 1 for any check that warns, the sandbox's or another one's
    if (provisioningOf(doctor.out) !== 'complete') return 'not-set-up'
    const echo = await a.run(READY_ARGV, env)
    return echo.code === 0 && echo.out.includes(READY_MARKER) ? 'ready' : 'not-set-up'
  } catch {
    return 'not-set-up'
  }
}

/**
 * Whether `codexHome` (null: the ambient account's, with CODEX_HOME unset) is ready for a sandboxed session. Never
 * rejects. A ready answer is kept for the process's life, and two starts asking at once share one question. A not-set-up
 * answer is not kept: the setup may run in another process (the Host runs 설정하기 while the app's own managers ask
 * too) or outside Astera, and asking such a home again runs doctor only, which cannot bring up the prompt.
 */
export function codexWindowsReadiness(a: { codexHome: string | null; run: CodexRun }): Promise<Readiness> {
  const key = keyOf(a.codexHome)
  const kept = answers.get(key)
  if (kept) return kept
  const asked = ask(a)
  answers.set(key, asked)
  void asked.then((r) => {
    if (r !== 'ready' && answers.get(key) === asked) answers.delete(key)
  })
  return asked
}

/** After a setup: every answer is forgotten, not only the home that was set up. The setup gave the machine's sandbox users
 *  new passwords that only that home holds, so another home that read ready before may be stale now; asked again, its
 *  echo says so. An answer still being asked goes too, since its echo may have run before the setup. */
export function forgetReadiness(): void {
  answers.clear()
}

/** Task 2's setup for the one home (the person's decision: accounts are set up one at a time, and Codex's own files are
 *  never copied between homes), then its answers forgotten. `out` is what Codex said, on one or more lines, or its exit
 *  when it said nothing. Never rejects. */
export async function codexWindowsSetup(a: { codexHome: string | null; run: CodexRun }): Promise<{ ok: boolean; out: string }> {
  let r: { code: number | null; out: string; err?: string }
  try {
    r = await a.run(SETUP_ARGV, homeEnv(a.codexHome))
  } catch (e) {
    return { ok: false, out: e instanceof Error ? e.message : String(e) }
  } finally {
    forgetReadiness()
  }
  const said = [r.out, r.err ?? ''].map((s) => s.trim()).filter((s) => s !== '').join('\n')
  return { ok: r.code === 0, out: said || `codex sandbox setup exited with code ${r.code ?? 'none'}` }
}

/** The real run: the codex on this process's PATH (by its path, never looked up in the working directory), in `base`
 *  with the caller's variables over it, a variable set to undefined left out. Stopped after `timeoutMs`. */
export function runCodex(base: Record<string, string | undefined>, timeoutMs: number = READINESS_RUN_MS): CodexRun {
  return (argv, extra) =>
    new Promise((resolve) => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries({ ...base, ...extra })) if (v !== undefined) env[k] = v
      const cmd = windowsSpawn('codex', argv)
      execFile(cmd.file, cmd.args, { env, windowsHide: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        // A number is codex's own exit; anything else (ENOENT, a kill at the time limit) means it did not exit by itself
        const exit = (err as { code?: unknown } | null)?.code
        const code = err ? (typeof exit === 'number' ? exit : null) : 0
        const why = err && code === null ? err.message : ''
        resolve({ code, out: stdout ?? '', err: [stderr ?? '', why].filter((s) => s !== '').join('\n') })
      })
    })
}
