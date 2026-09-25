// The one test that talks to a real `claude --output-format stream-json …`. Everything else in this
// folder runs against a fake proc and recorded frames (claudeAdapter.test.ts, core/chat/claudeFixtures.ts);
// this file is the check that the frames we recorded are still the frames the installed claude sends, and
// that the whole round trip — initialize, a turn that asks a question and takes our answer, a resume that
// keeps the session, a Write the person declines, an interrupted turn — works against a real login.
//
// **It is skipped unless ASTERA_LIVE_CLAUDE=1.** It spawns two processes, spends four turns of the
// account's usage and takes minutes, so it must never run as part of `npm test`. Run it on purpose:
//
//   ASTERA_LIVE_CLAUDE=1 npm test -- src/main/chat/claudeAdapter.live.test.ts
//
// One `it` runs the whole scenario in order, deliberately: every step needs the session the previous one
// built, and splitting it up would cost a fresh turn per test.
//
// ## No temporary home, unlike the Codex live test
//
// codexAdapter.live.test.ts has to build a throwaway CODEX_HOME because this machine's Codex answers its
// own approvals before the client is asked. Claude has no such setting in play: in the default permission
// mode a `Write` always asks, and the question reaches whoever holds the stdio permission prompt — us.
// So this test points `CLAUDE_CONFIG_DIR` straight at the account directory and **writes nothing under
// it**: it reads one transcript file's size, and nothing else touches that tree. The one file it creates
// anywhere is the probe file the Write turn is declined for, which must therefore never appear at all;
// afterAll removes it if the decline failed to prevent it.
//
// ## Two processes, because `--resume` is argv
//
// Claude has no `thread/resume` call: a session is resumed by launching the CLI again with
// `--resume=<session_id>` (core/chat/claudeProtocol.ts's claudeLaunchArgs). The adapter therefore only
// ever learns a fresh session's id from the first turn's `system/init`, and a resumed one is the id it was
// asked for — a claim that is only true if the CLI agrees, which is what the second half of this test
// measures. `claudeAdapter.ts`'s `thread` effect is gated on `threadId === null`, so a `--resume` that
// came back under a *different* id would be silently ignored; that is why the raw `system/init.session_id`
// of every turn is collected here (the `tee` below) rather than inferred from the adapter's own state.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { makeDescriptors } from '../../core/providers/descriptor'
import { cliEnvFor } from '../../core/sessions/cliEnv'
import { buildClaudeChatCommand } from '../../core/sessions/commands'
import type { ChatEvent, ChatRequest } from '../../core/chat/types'
import type { ProcLike } from '../../core/sessions/proc'
import type { Account } from '../../core/types'
import { createClaudeAdapter } from '../../core/chat/claudeAdapter'
import { nodeProcFactory } from './nodeProcFactory'

const LIVE = process.env.ASTERA_LIVE_CLAUDE === '1'

/** The repository root — this file is src/main/chat/, so three levels up. Used as the session's cwd: a
 *  real folder claude is happy to open, and the folder the Write turn is declined for. */
const REPO = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
/** The logged-in account the measurement used (slice3-records/claude-stream-measurements.md). Overridable
 *  so this test can be pointed at another machine's account without editing it. **Read only.** */
const CONFIG_DIR = process.env.ASTERA_LIVE_CLAUDE_CONFIG_DIR ?? 'C:\\Users\\anipen\\.claude-accounts\\claude3-anipen-com-2'
/** What the Write turn would create if the decline did not stop it. Asserted absent; removed in afterAll. */
const PROBE_FILE = path.join(REPO, 'astera-claude-live-probe.txt')

/** Verbatim from docs/superpowers/specs/2026-09-15-chat-sessions-slice3-records/probe-claude-stream.mjs
 *  — the wording that reliably makes AskUserQuestion the first thing the turn does. */
const ASK_PROMPT =
  'Call the AskUserQuestion tool immediately, before anything else, with exactly these two questions and nothing else. ' +
  'Question 1: header "Format", question "How should I format the output?", multiSelect false, options: ' +
  '"Summary" (description "Brief overview of key points"), "Detailed" (description "Full explanation with examples"). ' +
  'Question 2: header "Sections", question "Which sections should I include?", multiSelect true, options: ' +
  '"Introduction" (description "Opening context"), "Methods" (description "How the work was done"), "Results" (description "What came out"). ' +
  'After I answer, reply with exactly the answers you received, one per line, prefixed with ANSWER:.'

/** The one turn the resumed process runs before the legs that spend the rest of it: short on purpose,
 *  since all it has to produce is a `system/init` to read the session id off. */
const RESUME_PROMPT = 'Reply with exactly the word RESUMED.'

/** A file write always asks in the default permission mode (measured; read-only git does not). "Do not
 *  ask me anything first" keeps the model from spending the turn on AskUserQuestion instead. */
const WRITE_PROMPT =
  'Use the Write tool to create a new file named astera-claude-live-probe.txt in the current directory ' +
  'containing the single word probe. Do not ask me anything first. If the tool is refused, reply DENIED and stop.'

const COUNT_PROMPT = 'Count slowly from 1 to 80, one number per line, no other text.'

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

/** The pids of the live children, so the afterAll below can be sure they are gone even if an expect threw
 *  before `kill()`. An entry is zeroed once its adapter has reported the exit. */
const livePids: number[] = []

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

/** The environment a chat session's claude gets, built the way the manager builds it
 *  (ChatSessionManager.spawn → cliEnvFor), plus the two scrubs a *test* needs and the app does not:
 *  vitest does not set ELECTRON_RUN_AS_NODE but a run started from inside Electron would, and this test
 *  itself runs inside a Claude Code session, whose `CLAUDE_CODE_*` marks tell the child it is a child
 *  session — which makes it write no transcript at all (see cliEnv.ts's INHERITED_AGENT_ENV_KEYS note;
 *  that list names the marks the app can meet, this scrubs the whole prefix as the probe script did). */
function claudeEnv(): Record<string, string | undefined> {
  const homeDir = os.homedir()
  const account: Account = {
    id: 'live-claude',
    label: 'live claude',
    configDir: CONFIG_DIR,
    color: '#888888',
    createdAt: new Date().toISOString(),
    provider: 'claude'
  }
  const env = cliEnvFor({ base: process.env, account, descriptor: makeDescriptors(process.platform, homeDir).claude, homeDir })
  delete env.ELECTRON_RUN_AS_NODE
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_')) delete env[k]
  return env
}

/** One live claude, with its stdout copied out on the way past.
 *
 *  The copy is not decoration. `initIds` is the only place the *CLI's* own session id can be read: the
 *  adapter keeps the first one and ignores every later `system/init` by design, so "did `--resume` come
 *  back under the id we asked for" is a question its state cannot answer. `assistants` is what makes the
 *  interrupt leg honest — a turn is only worth interrupting once the model has actually started talking,
 *  which is how the probe script timed its own interrupt. */
interface Wire {
  proc: ProcLike
  pid: number
  /** Every `system/init.session_id` announced by this process, in arrival order. */
  initIds: string[]
  /** One entry per `assistant` line; only the count is read. */
  assistants: string[]
}

function startClaude(resumeSessionId?: string): Wire {
  const { file, args } = buildClaudeChatCommand(process.platform, { bypass: false, resumeSessionId })
  const real = nodeProcFactory(file, args, { cwd: REPO, env: claudeEnv() })
  const initIds: string[] = []
  const assistants: string[] = []
  const tee = (line: string): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    const o = parsed as { type?: unknown; subtype?: unknown; session_id?: unknown }
    if (o.type === 'system' && o.subtype === 'init' && typeof o.session_id === 'string') initIds.push(o.session_id)
    else if (o.type === 'assistant') assistants.push(line)
  }
  const proc: ProcLike = {
    get pid() {
      return real.pid
    },
    onLine: (cb) => real.onLine((line) => {
      tee(line)
      cb(line)
    }),
    onExit: (cb) => real.onExit(cb),
    write: (line) => real.write(line),
    kill: () => real.kill()
  }
  livePids.push(real.pid)
  return { proc, pid: real.pid, initIds, assistants }
}

/** The transcript claude writes for a session: `<CLAUDE_CONFIG_DIR>/projects/<slug>/<session_id>.jsonl`.
 *  Found by a one-level search rather than by rebuilding the slug, which is exactly how the app finds it
 *  (core/history/index.ts's transcriptPathById). */
function transcriptOf(sessionId: string): string | null {
  const root = path.join(CONFIG_DIR, 'projects')
  if (!existsSync(root)) return null
  for (const dir of readdirSync(root)) {
    const file = path.join(root, dir, `${sessionId}.jsonl`)
    if (existsSync(file)) return file
  }
  return null
}

const suite = LIVE ? describe : describe.skip

suite('claudeAdapter against a real claude stream-json session', () => {
  afterAll(() => {
    for (const pid of livePids) killTree(pid)
    livePids.length = 0
    // The decline is supposed to make this impossible; if it did not, the repository does not keep the
    // evidence — the assertion in the test is what reports it.
    if (existsSync(PROBE_FILE)) rmSync(PROBE_FILE, { force: true })
  })

  // The options go *before* the body: vitest 4 dropped the trailing-options overload (it is
  // `it(name, options, fn)` or `it(name, fn, timeoutMs)`, never `it(name, fn, options)`).
  it(
    'asks and answers a question, resumes the same session, declines a Write, and takes an interrupt',
    { timeout: 480_000 },
    async () => {
      const env = claudeEnv()
      expect(env.CLAUDE_CONFIG_DIR).toBe(CONFIG_DIR)
      expect(env.CLAUDECODE).toBeUndefined()

      // ---- 1: a fresh session, and the handshake that names no session at all ----
      const first = startClaude()
      const events: ChatEvent[] = []
      const a = createClaudeAdapter({ proc: first.proc, mode: { mode: 'fresh' }, version: 'live-test', log: (m) => console.log(`[adapter] ${m}`) })
      a.on((e) => events.push(e))

      await a.start({ cwd: REPO, bypass: false })
      // Where Claude parts company with Codex: `initialize` hands over the model catalogue and the
      // permission mode and nothing else — no session id, so no `ready`, and no model in force yet.
      expect(events.filter((e) => e.type === 'ready')).toEqual([])
      expect(a.state().status).toBe('idle')
      expect(a.state().model.model).toBeNull()
      expect((await a.listModels()).length).toBeGreaterThan(0)

      // ---- 2: a turn that asks, and our answer to it ----
      await a.send(ASK_PROMPT)
      await until('a question request', 180_000, () => a.state().request?.kind === 'question')
      const question = a.state().request as Extract<ChatRequest, { kind: 'question' }>
      expect(question.form.questions.map((q) => q.header)).toEqual(['Format', 'Sections'])
      expect(question.form.questions[0].options.map((o) => o.label)).toEqual(['Summary', 'Detailed'])
      expect(question.form.questions[0].multiSelect).toBe(false)
      // The one the card has to draw as checkboxes — asked for as multiSelect in the prompt, and carried
      // through `parseAskUserQuestion` unchanged.
      expect(question.form.questions[1].multiSelect).toBe(true)
      await a.answer(question.id, {
        kind: 'question',
        answers: [
          { picks: [1], other: '' },
          { picks: [0, 1], other: '' }
        ]
      })
      await until('idle after the answer', 240_000, () => a.state().status === 'idle')
      expect(a.state().request).toBeNull()
      expect(a.state().error).toBeNull()

      // The session announced itself at the head of that turn, not before it.
      const ready = events.find((e): e is Extract<ChatEvent, { type: 'ready' }> => e.type === 'ready')
      expect(ready).toBeDefined()
      const sessionId = ready?.threadId ?? ''
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
      expect(a.state().model.model).not.toBeNull()
      // Every `system/init` of this process carried the same id (measured: one per turn).
      expect([...new Set(first.initIds)]).toEqual([sessionId])

      // The transcript claude writes for it — the file the conversation view reads (Task 5).
      await until('the transcript file', 30_000, () => transcriptOf(sessionId) !== null)
      const transcript = transcriptOf(sessionId) as string
      const sizeAfterFirstTurn = statSync(transcript).size
      expect(sizeAfterFirstTurn).toBeGreaterThan(0)

      // ---- 3: the process goes away when told to ----
      a.kill()
      await until('the first exit event', 15_000, () => events.some((e) => e.type === 'exit'))
      livePids[0] = 0

      // ---- 4: --resume, and whether the id survives it ----
      const second = startClaude(sessionId)
      const events2: ChatEvent[] = []
      const b = createClaudeAdapter({ proc: second.proc, mode: { mode: 'fresh' }, version: 'live-test', log: (m) => console.log(`[adapter] ${m}`) })
      b.on((e) => events2.push(e))

      await b.start({ cwd: REPO, resumeThreadId: sessionId, bypass: false })
      // Ready at once this time, on the id we asked for, before a single turn has run.
      const ready2 = events2.filter((e): e is Extract<ChatEvent, { type: 'ready' }> => e.type === 'ready')
      expect(ready2.map((e) => e.threadId)).toEqual([sessionId])

      await b.send(RESUME_PROMPT)
      await until('idle after the resumed turn', 240_000, () => b.state().status === 'idle')
      expect(b.state().error).toBeNull()
      // **The finding this leg exists for.** The adapter takes the resumed id on trust (its `thread`
      // effect is gated on `threadId === null`, so a different id would never be remembered); this is the
      // CLI's own answer, read off the wire. A failure here means `--resume` forks the session and the
      // app's stored thread id is stale from the first turn onwards.
      expect([...new Set(second.initIds)]).toEqual([sessionId])
      // ...and no second `ready`, whatever else the resumed process said.
      expect(events2.filter((e) => e.type === 'ready')).toHaveLength(1)
      // The same transcript file, longer than it was — not a new one beside it.
      expect(transcriptOf(sessionId)).toBe(transcript)
      expect(statSync(transcript).size).toBeGreaterThan(sizeAfterFirstTurn)

      // ---- 5: a Write the person declines ----
      // Deterministic in the default permission mode, which is the mode a non-bypass session starts in:
      // there is no "or the turn finished without asking" branch because being asked is the only
      // legitimate outcome (measured).
      expect(existsSync(PROBE_FILE)).toBe(false)
      await b.send(WRITE_PROMPT)
      await until('an approval request', 240_000, () => b.state().request?.kind === 'approval')
      const approval = b.state().request as Extract<ChatRequest, { kind: 'approval' }>
      expect(approval.about.tool).toBe('Write')
      expect(approval.about.lines.some((l) => l.includes('astera-claude-live-probe.txt'))).toBe(true)
      // What Claude offers for a Write: all three, because the request carries a `permission_suggestions`
      // entry with `destination: 'session'` and does not suppress the always-allow rule.
      expect(approval.decisions).toEqual(['accept', 'acceptForSession', 'decline'])
      await b.answer(approval.id, { kind: 'approval', decision: 'decline' })
      await until('idle after the decline', 240_000, () => b.state().status === 'idle')
      expect(b.state().request).toBeNull()
      // A declined tool is not a failed turn: the model is told no and answers.
      expect(b.state().error).toBeNull()
      expect(existsSync(PROBE_FILE)).toBe(false)

      // ---- 6: an interrupted turn ----
      const assistantsBefore = second.assistants.length
      await b.send(COUNT_PROMPT)
      expect(b.state().status).toBe('working')
      // Interrupting before the model has said anything would measure the CLI's idle-interrupt path, not
      // the one the stop button takes — so wait for this turn's first assistant line, as the probe did.
      await until('the counting turn to start talking', 120_000, () => second.assistants.length > assistantsBefore)
      const t0 = Date.now()
      await b.interrupt()
      await until('idle after the interrupt', 20_000, () => b.state().status === 'idle')
      console.log(`[live] interrupt to idle: ${Date.now() - t0} ms`)
      // `result { is_error: true, terminal_reason: 'aborted_streaming' }` is an interrupt, not a failure.
      expect(b.state().error).toBeNull()

      // ---- 7: the second process goes away too ----
      b.kill()
      await until('the second exit event', 15_000, () => events2.some((e) => e.type === 'exit'))
      livePids[1] = 0

      // Nothing the CLI asked for went unanswered as "unsupported" — that is the one error that would
      // mean the recorded fixtures have drifted from the installed claude.
      const unsupported = [...events, ...events2]
        .filter((e): e is Extract<ChatEvent, { type: 'error' }> => e.type === 'error')
        .filter((e) => e.message.includes('unsupported request'))
      expect(unsupported).toEqual([])
    }
  )
})
