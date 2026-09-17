// The one test that talks to a real `codex app-server`. Everything else in this folder runs against a
// fake proc and recorded frames (codexAdapter.test.ts, core/chat/codexFixtures.ts); this file is the
// check that the frames we recorded are still the frames the installed codex sends, and that the whole
// round trip — handshake, a plan-mode turn that asks a question and takes our answer, a turn that asks
// permission to run a command and is declined — works against the machine's own Codex login.
//
// **It is skipped unless ASTERA_LIVE_CODEX=1.** It spawns a process, spends two turns of the account's
// usage and takes about two minutes, so it must never run as part of `npm test`. Run it on purpose:
//
//   ASTERA_LIVE_CODEX=1 npm test -- src/main/chat/codexAdapter.live.test.ts
//
// One `it` runs the whole scenario in order, deliberately: each step needs the thread the previous one
// built, and splitting it into three tests would cost three turns instead of two.
//
// ## The temporary CODEX_HOME, and why the approval step needs one
//
// On a Codex configured the way this machine is (`approvals_reviewer = "auto_review"` in
// `~/.codex/config.toml`), Codex's own reviewer answers every approval before the client is asked — so
// with the person's own home the approval step could only ever assert "either we were asked or we were
// not", which asserts nothing. Measured four times; the whole history is in
// `.superpowers/sdd/2026-09-15-chat-sessions-slice2-codex/task-11-report.md`.
//
// What does reach the client, proved end to end in that report's "Run 6", is two settings stacked in a
// throwaway home this test builds in `beforeAll`:
//
//   1. `approvals_reviewer = "user"`, so the reviewer steps aside and the escalation reaches us;
//   2. an execpolicy `prompt` rule in `<home>/rules/default.rules`, so Codex asks **before** running the
//      command rather than only after something failed in the sandbox.
//
// Rule shapes matter. Codex runs a command as `<shell> -Command "<the command>"` (measured:
// `"C:\Program Files\PowerShell\7\pwsh.exe" -Command "…"`), so the file carries the wrapper shapes as
// well as bare `curl`, and backslashes are doubled in the Starlark source — written singly, `\7` in
// `…\PowerShell\7\…` is read as an octal escape and the rule silently never matches. The installed
// binary's own checker (`codex execpolicy check --rules <file> <argv…>`) is run as a pre-flight below,
// so a syntax slip costs zero Codex turns.
//
// **That home holds a copy of the person's `auth.json`.** It is deleted in `afterAll` whether the test
// passed or failed, and the hook asserts it is gone. Nothing under `~/.codex` is ever written: the
// config is read, amended in memory and written to the copy.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeDescriptors } from '../../core/providers/descriptor'
import { cliEnvFor } from '../../core/sessions/cliEnv'
import { buildCodexAppServerCommand } from '../../core/sessions/commands'
import type { ChatEvent, ChatRequest } from '../../core/chat/types'
import type { Account } from '../../core/types'
import { createCodexAdapter } from './codexAdapter'
import { nodeProcFactory } from './nodeProcFactory'

const LIVE = process.env.ASTERA_LIVE_CODEX === '1'

/** The repository root — this file is src/main/chat/, so three levels up. Used as the thread's cwd: a
 *  real folder codex is happy to open. */
const REPO = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
/** The person's own Codex home. **Read only** — everything this test writes goes to the copy. */
const SRC_CODEX_HOME = path.join(os.homedir(), '.codex')

/** Verbatim from docs/superpowers/specs/2026-09-15-chat-sessions-slice2-records/probe-codex-appserver.mjs
 *  — the wording that reliably forces request_user_input as the first thing the turn does. */
const QUESTION_PROMPT =
  'Use the request_user_input tool right now, before anything else, to ask me exactly two questions. ' +
  'Question 1: header "Format", question "How should I format the output?", options "Summary" (description "Brief overview"), "Detailed" (description "Full explanation"). ' +
  'Question 2: header "Sections", question "Which sections should I include?", options "Introduction" (description "Opening context"), "Methods" (description "How the work was done"). ' +
  'After I answer, reply with exactly the answers you received, one per line, prefixed with ANSWER:.'

/** Verbatim from e2e-approval-card-rule.mjs — the prompt that produced an approval request in run 6.
 *  `--max-time 5` is the belt to the rule's braces: if the command does run after all, the sandbox's
 *  dropped connection becomes an exit-28 failure in five seconds rather than a hang. */
const SHELL_PROMPT = 'Run exactly this shell command and tell me its first output line: curl --max-time 5 -sI https://example.com'
const CURL = 'curl --max-time 5 -sI https://example.com'
const RULE_JUSTIFICATION = 'Astera live test: force an approval request'

/** Doubled backslashes on purpose — see the header. */
const RULE_PREFIXES: string[][] = [
  ['curl'],
  ['curl.exe'],
  ['pwsh.exe', '-Command'],
  ['powershell.exe', '-Command'],
  ['C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe', '-Command'],
  ['C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe', '-Command'],
  ['cmd.exe', '/c'],
  ['C:\\\\Windows\\\\System32\\\\cmd.exe', '/c'],
  ['bash', '-lc']
]

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Polls `ok` every 250 ms. Written as a predicate rather than a value reader so the caller can read the
 *  state it wants *after* the wait, with its own narrowing, instead of threading a generic through here. */
async function until(label: string, timeoutMs: number, ok: () => boolean): Promise<void> {
  const t0 = Date.now()
  while (!ok()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label} (${timeoutMs} ms)`)
    await wait(250)
  }
}

/** The pid of the live child, so the afterAll below can be sure it is gone even if an expect threw
 *  before `kill()`. Zeroed once the adapter has reported its exit. */
let livePid = 0
/** The throwaway Codex home, empty until beforeAll has made one. Assigned first thing, so a failure
 *  anywhere after that still leaves afterAll something to delete. */
let codexHome = ''

function killTree(pid: number): void {
  if (pid <= 0) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

/** The installed `codex`, as a path execFileSync can run. `cmd.exe /c codex …` — the shape the app
 *  spawns the server with — cannot be used here: Node's cmd.exe argument escaping eats the backslashes
 *  out of the Windows paths this checker has to be handed verbatim (measured: the rules path came back
 *  as `C:UsersanipenAppData…`). */
function codexExecutable(): string {
  const fromEnv = process.env.ASTERA_CODEX_EXE
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const local = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')
  if (process.platform === 'win32' && existsSync(local)) return local
  return 'codex'
}

const suite = LIVE ? describe : describe.skip

suite('codexAdapter against a real codex app-server', () => {
  beforeAll(() => {
    codexHome = mkdtempSync(path.join(os.tmpdir(), 'astera-live-codexhome-'))

    // The person's config, with the reviewer forced aside. Replaced in place when the line exists so
    // the rest of their settings (model, provider, everything else) come along unchanged.
    const srcConfig = readFileSync(path.join(SRC_CODEX_HOME, 'config.toml'), 'utf8')
    const config = /^\s*approvals_reviewer\s*=.*$/m.test(srcConfig)
      ? srcConfig.replace(/^\s*approvals_reviewer\s*=.*$/m, 'approvals_reviewer = "user"')
      : `approvals_reviewer = "user"\n${srcConfig}`
    writeFileSync(path.join(codexHome, 'config.toml'), config)
    copyFileSync(path.join(SRC_CODEX_HOME, 'auth.json'), path.join(codexHome, 'auth.json'))

    // The person's own rules first, verbatim, then ours — a home with a rules file replaces theirs
    // entirely, and dropping their rules would change what this account is allowed to do.
    const srcRulesPath = path.join(SRC_CODEX_HOME, 'rules', 'default.rules')
    const srcRules = existsSync(srcRulesPath) ? `${readFileSync(srcRulesPath, 'utf8').trimEnd()}\n` : ''
    const ourRules = RULE_PREFIXES.map(
      (p) => `prefix_rule(pattern = [${p.map((tok) => `"${tok}"`).join(', ')}], decision = "prompt", justification = "${RULE_JUSTIFICATION}")`
    ).join('\n')
    mkdirSync(path.join(codexHome, 'rules'), { recursive: true })
    const rulesPath = path.join(codexHome, 'rules', 'default.rules')
    writeFileSync(rulesPath, `${srcRules}${ourRules}\n`)

    // Pre-flight, against the installed binary's own checker, before a single Codex turn is spent.
    const exe = codexExecutable()
    const check = (argv: string[]): string => {
      try {
        const out = execFileSync(exe, ['execpolicy', 'check', '--rules', rulesPath, ...argv], { encoding: 'utf8', windowsHide: true })
        return (JSON.parse(out) as { decision?: string }).decision ?? '(no decision)'
      } catch (e) {
        const err = e as { stderr?: string; message?: string }
        return `check failed: ${String(err.stderr || err.message).slice(0, 300)}`
      }
    }
    const preflight = {
      bareCurl: check(['curl', '--max-time', '5', '-sI', 'https://example.com']),
      pwshFullPath: check(['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-Command', CURL]),
      powershellFullPath: check(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-Command', CURL]),
      pwshShort: check(['pwsh.exe', '-Command', CURL])
    }
    console.log('[live] execpolicy pre-flight', preflight)
    if (!Object.values(preflight).includes('prompt')) {
      throw new Error(
        `execpolicy pre-flight failed: no command shape resolves to "prompt", so the approval step ` +
          `could not be triggered and no Codex turn was spent. checker: ${exe}; rules: ${rulesPath}; ` +
          `decisions: ${JSON.stringify(preflight)}`
      )
    }
  })

  afterAll(async () => {
    killTree(livePid)
    livePid = 0
    if (codexHome === '') return
    // The server may still have the directory open for a moment after being killed; a few tries beat
    // one failure, and the assertion below is what makes "the credential copy is gone" a claim this
    // test has actually checked.
    const home = codexHome
    codexHome = ''
    for (let i = 0; i < 5 && existsSync(home); i++) {
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {
        await wait(300)
      }
    }
    expect(existsSync(home), `the temporary CODEX_HOME (a copy of auth.json) is still on disk: ${home}`).toBe(false)
  })

  // The options go *before* the body: vitest 4 dropped the trailing-options overload (it is
  // `it(name, options, fn)` or `it(name, fn, timeoutMs)`, never `it(name, fn, options)`).
  it(
    'starts a thread, asks and answers a plan-mode question, declines a shell command, and exits',
    { timeout: 180_000 },
    async () => {
      const homeDir = os.homedir()
      const descriptors = makeDescriptors(process.platform, homeDir)
      const account: Account = {
        id: 'live-codex',
        label: 'live codex',
        // The throwaway home, not `~/.codex`: reached exactly the way the manager reaches an account's
        // own directory, so cliEnvFor plants CODEX_HOME for the spawned server.
        configDir: codexHome,
        color: '#888888',
        createdAt: new Date().toISOString(),
        provider: 'codex'
      }
      const env = cliEnvFor({ base: process.env, account, descriptor: descriptors.codex, homeDir })
      // Vitest does not set it, but a run started from inside Electron would: codex must not be told to
      // behave as node.
      delete env.ELECTRON_RUN_AS_NODE
      expect(env.CODEX_HOME).toBe(codexHome)

      const { file, args } = buildCodexAppServerCommand(process.platform)
      const proc = nodeProcFactory(file, args, { cwd: REPO, env })
      livePid = proc.pid

      const events: ChatEvent[] = []
      const a = createCodexAdapter({
        proc,
        mode: { mode: 'fresh' },
        version: 'live-test',
        log: (m) => console.log(`[adapter] ${m}`)
      })
      a.on((e) => events.push(e))

      // 1 — the handshake.
      await a.start({ cwd: REPO, bypass: false })
      const ready = events.find((e): e is Extract<ChatEvent, { type: 'ready' }> => e.type === 'ready')
      expect(ready).toBeDefined()
      expect(ready?.threadId).toMatch(/^[0-9a-f-]{36}$/)
      expect(a.state().status).toBe('idle')
      // Seeded from thread/start rather than left blank until the first settings update.
      expect(a.state().model.model).not.toBeNull()

      // 2 — a plan-mode turn that asks, and our answer to it.
      await a.setPlanMode(true)
      await a.send(QUESTION_PROMPT)
      await until('a question request', 120_000, () => a.state().request?.kind === 'question')
      const question = a.state().request as Extract<ChatRequest, { kind: 'question' }>
      expect(question.form.questions.map((q) => q.header)).toEqual(['Format', 'Sections'])
      expect(question.form.questions[0].options.map((o) => o.label)).toEqual(['Summary', 'Detailed'])
      await a.answer(question.id, {
        kind: 'question',
        answers: [
          { picks: [1], other: '' },
          { picks: [1], other: '' }
        ]
      })
      await until('idle after the answer', 120_000, () => a.state().status === 'idle')
      expect(a.state().model.planMode).toBe(true)
      expect(a.state().request).toBeNull()

      // 3 — a shell command the execpolicy rule in the temporary home makes Codex ask about before
      // running it. There is no "or the turn finished without asking" branch: the home this test built
      // is precisely what makes being asked the only legitimate outcome (see the header).
      await a.setPlanMode(false)
      await a.send(SHELL_PROMPT)
      await until('an approval request', 120_000, () => a.state().request?.kind === 'approval')
      const approval = a.state().request as Extract<ChatRequest, { kind: 'approval' }>
      expect(approval.about.tool).toBe('shell')
      expect(approval.about.lines.some((l) => l.includes('curl'))).toBe(true)
      // What Codex offers for a command approval: no acceptForSession, because `availableDecisions`
      // does not list it (core/chat/codexProtocol.ts's decisionsOf).
      expect(approval.decisions).toEqual(['accept', 'decline'])
      await a.answer(approval.id, { kind: 'approval', decision: 'decline' })
      await until('idle after the decline', 120_000, () => a.state().status === 'idle')
      expect(a.state().request).toBeNull()

      // 4 — the process goes away when told to.
      a.kill()
      await until('the exit event', 15_000, () => events.some((e) => e.type === 'exit'))
      livePid = 0

      // Nothing the server asked for went unanswered as "unsupported" — that is the one error that would
      // mean the recorded fixtures have drifted from the installed codex.
      const unsupported = events
        .filter((e): e is Extract<ChatEvent, { type: 'error' }> => e.type === 'error')
        .filter((e) => e.message.includes('unsupported request'))
      expect(unsupported).toEqual([])
    }
  )
})
