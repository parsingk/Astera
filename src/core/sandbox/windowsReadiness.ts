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
//
// Only a report that reads "incomplete" (or a stale echo) is a home to set up. When Codex could not be asked at all (not
// there, too old for `doctor --json`, timed out, a report that does not read), setting up would not help: that is its
// own answer, `check-failed` (`SANDBOX_UNAVAILABLE: windows-check-failed codex <account>`), with no setup offered.
import { execFile } from 'node:child_process'
import os from 'node:os'
import { windowsSpawn } from '../sessions/windowsExecutable'

export type Readiness = 'ready' | 'not-set-up' | 'check-failed'

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

/** A few words of what codex printed, for the log line of a report that did not read. */
const gist = (r: { out: string; err?: string }): string => `${r.out} ${r.err ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, 200)

/** One question: doctor, then (only on a complete report) the echo. Each way it could not be asked is logged once. */
async function ask(a: { codexHome: string | null; run: CodexRun; log: (m: string) => void }): Promise<Readiness> {
  const env = homeEnv(a.codexHome)
  const home = a.codexHome ?? 'the default Codex home'
  const failed = (why: string): Readiness => {
    a.log(`sandbox: the Windows sandbox of ${home} could not be asked about: ${why}`)
    return 'check-failed'
  }
  let doctor: Awaited<ReturnType<CodexRun>>
  try {
    doctor = await a.run(DOCTOR_ARGV, env)
  } catch (e) {
    return failed(`codex could not be run: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (doctor.code === null) return failed(`codex doctor did not answer (not found, or timed out): ${gist(doctor)}`)
  // Not the exit code: doctor exits 1 for any check that warns, the sandbox's or another one's. A codex without
  // `doctor --json` says so on stderr, and its report does not read either.
  const report = parseReport(doctor.out)
  if (report === null) return failed(`codex doctor's report did not read (exit ${doctor.code}): ${gist(doctor)}`)
  const provisioning = provisioningOf(doctor.out)
  if (provisioning === null) return failed("codex doctor's report names no sandbox provisioning")
  if (provisioning === 'incomplete') return 'not-set-up'
  if (provisioning !== 'complete') return failed(`codex doctor reported sandbox provisioning "${provisioning}"`)
  let echo: Awaited<ReturnType<CodexRun>>
  try {
    echo = await a.run(READY_ARGV, env)
  } catch (e) {
    return failed(`codex could not be run for the sandbox echo: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (echo.code === null) return failed(`the sandbox echo did not answer (timed out): ${gist(echo)}`)
  // A complete home whose echo fails is stale: another home's setup gave the sandbox users new passwords (setting it up
  // again is the remedy)
  return echo.code === 0 && echo.out.includes(READY_MARKER) ? 'ready' : 'not-set-up'
}

/** Bumped by every forgetReadiness: an ask that began before a setup is asked again, never answered from before it. */
let generation = 0
/** How many times one start asks again because setups kept running meanwhile, before it says it could not ask. */
const ASKS_PER_START = 3

async function askSince(a: { codexHome: string | null; run: CodexRun; log: (m: string) => void }): Promise<Readiness> {
  for (let i = 0; i < ASKS_PER_START; i++) {
    const asked = generation
    const r = await ask(a)
    if (asked === generation) return r
    // A setup ran while this was being asked, so the answer may be from before it: ask again
  }
  a.log(`sandbox: the Windows sandbox of ${a.codexHome ?? 'the default Codex home'} was set up again each time it was asked`)
  return 'check-failed'
}

/**
 * Whether `codexHome` (null: the ambient account's, with CODEX_HOME unset) is ready for a sandboxed session. Never
 * rejects. A ready answer is kept for the process's life, and two starts asking at once share one question. Any other
 * answer is not kept: the setup may run in another process (the Host runs 설정하기 while the app's own managers ask
 * too) or outside Astera, and asking such a home again runs doctor only, which cannot bring up the prompt. `log` says
 * which way Codex could not be asked, when it could not.
 */
export function codexWindowsReadiness(a: { codexHome: string | null; run: CodexRun; log?: (m: string) => void }): Promise<Readiness> {
  const key = keyOf(a.codexHome)
  const kept = answers.get(key)
  if (kept) return kept
  const asked = askSince({ ...a, log: a.log ?? (() => {}) })
  answers.set(key, asked)
  void asked.then((r) => {
    if (r !== 'ready' && answers.get(key) === asked) answers.delete(key)
  })
  return asked
}

/** After a setup: every answer is forgotten, not only the home that was set up. The setup gave the machine's sandbox users
 *  new passwords that only that home holds, so another home that read ready before may be stale now; asked again, its
 *  echo says so. An ask still under way is asked again when it ends (`generation`), since its echo may have run before
 *  the setup. */
export function forgetReadiness(): void {
  generation++
  answers.clear()
}

/** Task 2's setup for the one home (the person's decision: accounts are set up one at a time, and Codex's own files are
 *  never copied between homes), then its answers forgotten. `out` is what Codex said, on one or more lines; empty when it
 *  said nothing, and the app then says it in its own words (session.spawn.sandbox.setUpFailed). Never rejects. */
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
  return { ok: r.code === 0, out: said }
}

/** The real run: the codex on this process's PATH (by its path, never looked up in the working directory), in `base`
 *  with the caller's variables over it, a variable set to undefined left out, run out of the temp folder rather than
 *  whatever folder the asking process is in. Stopped after `timeoutMs`. `exec` is a test seam. */
export function runCodex(base: Record<string, string | undefined>, timeoutMs: number = READINESS_RUN_MS, exec: typeof execFile = execFile): CodexRun {
  return (argv, extra) =>
    new Promise((resolve) => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries({ ...base, ...extra })) if (v !== undefined) env[k] = v
      const cmd = windowsSpawn('codex', argv)
      const opts = { env, cwd: os.tmpdir(), windowsHide: true, encoding: 'utf8' as const, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }
      exec(cmd.file, cmd.args, opts, (err, stdout, stderr) => {
        // A number is codex's own exit; anything else (ENOENT, a kill at the time limit) means it did not exit by itself
        const exit = (err as { code?: unknown } | null)?.code
        const code = err ? (typeof exit === 'number' ? exit : null) : 0
        const why = err && code === null ? err.message : ''
        resolve({ code, out: stdout ?? '', err: [stderr ?? '', why].filter((s) => s !== '').join('\n') })
      })
    })
}
