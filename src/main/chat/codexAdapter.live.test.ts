// The one test that talks to a real `codex app-server`. Everything else in this folder runs against a
// fake proc and recorded frames (codexAdapter.test.ts, core/chat/codexFixtures.ts); this file is the
// check that the frames we recorded are still the frames the installed codex sends, and that the whole
// round trip — handshake, a plan-mode turn that asks a question and takes our answer, a turn that
// changes a file — works against the machine's own Codex login.
//
// **It is skipped unless ASTERA_LIVE_CODEX=1.** It spawns a process, spends two turns of the account's
// usage and takes about two minutes, so it must never run as part of `npm test`. Run it on purpose:
//
//   ASTERA_LIVE_CODEX=1 npm test -- src/main/chat/codexAdapter.live.test.ts
//
// One `it` runs the whole scenario in order, deliberately: each step needs the thread the previous one
// built, and splitting it into four tests would cost four turns instead of two.
//
// The account is the ambient one (`~/.codex`), reached the way the manager reaches it — cliEnvFor with
// the codex descriptor, which *deletes* CODEX_HOME for an ambient dir rather than setting it (setting it
// would make codex re-ask for login). Nothing outside the scratch of this test is written: the only file
// it can touch is the probe file below, which the decline is supposed to prevent and the cleanup removes
// if codex wrote it anyway.
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { makeDescriptors } from '../../core/providers/descriptor'
import { cliEnvFor } from '../../core/sessions/cliEnv'
import { buildCodexAppServerCommand } from '../../core/sessions/commands'
import type { ChatEvent, ChatRequest } from '../../core/chat/types'
import type { Account } from '../../core/types'
import { createCodexAdapter } from './codexAdapter'
import { nodeProcFactory } from './nodeProcFactory'

const LIVE = process.env.ASTERA_LIVE_CODEX === '1'

/** The repository root — this file is src/main/chat/, so three levels up. Used as the thread's cwd (a
 *  real folder codex is happy to open) and as the folder the declined file change would have written to. */
const REPO = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const PROBE_FILE = path.join(REPO, 'astera-live-probe.txt')

/** Verbatim from docs/superpowers/specs/2026-09-15-chat-sessions-slice2-records/probe-codex-appserver.mjs
 *  — the wording that reliably forces request_user_input as the first thing the turn does. */
const QUESTION_PROMPT =
  'Use the request_user_input tool right now, before anything else, to ask me exactly two questions. ' +
  'Question 1: header "Format", question "How should I format the output?", options "Summary" (description "Brief overview"), "Detailed" (description "Full explanation"). ' +
  'Question 2: header "Sections", question "Which sections should I include?", options "Introduction" (description "Opening context"), "Methods" (description "How the work was done"). ' +
  'After I answer, reply with exactly the answers you received, one per line, prefixed with ANSWER:.'

/** Verbatim from probe-codex-filechange.mjs (bar the file name) — forces apply_patch rather than a shell
 *  command, so an approval, if one is asked for at all, is `item/fileChange/requestApproval` and not the
 *  shell one.
 *
 *  **Whether one is asked for depends on the Codex install, so the step below accepts both answers.**
 *  Measured 2026-09-16 against codex 0.154.0 with the parameters this adapter sends
 *  (`approvalPolicy: 'on-request'`, `sandbox: 'workspace-write'` — threadStartParams with bypass false):
 *  the turn wrote the file and the client was sent **no server request at all**. The frames show why —
 *  `item/autoApprovalReview/started` → `guardianWarning` ("Automatic approval review approved (risk:
 *  low, authorization: high)") → `item/autoApprovalReview/completed` → the write goes through. That
 *  reviewer is a Codex setting (`approvals_reviewer = "auto_review"` in config.toml), and it stands
 *  between `on-request` and the client. The recorded fixture the codec was built from
 *  (appserver-filechange-record.jsonl) got its approval from an `untrusted` thread, which this adapter
 *  never starts. A write *outside* the workspace was measured too, and the reviewer approved that as
 *  well. So on a Codex configured this way the decline path cannot be reached from here at all; on one
 *  without the reviewer it can, and then the step asserts the full shape. */
const FILE_PROMPT =
  'Create a new file named astera-live-probe.txt in the repository root containing the single word probe. ' +
  'Use the apply_patch tool, not a shell command. Do not ask me anything. ' +
  'If the change is not allowed, reply DENIED and stop.'

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

const suite = LIVE ? describe : describe.skip

suite('codexAdapter against a real codex app-server', () => {
  afterAll(() => {
    killTree(livePid)
    livePid = 0
    if (existsSync(PROBE_FILE)) rmSync(PROBE_FILE, { force: true })
  })

  // The options go *before* the body: vitest 4 dropped the trailing-options overload (it is
  // `it(name, options, fn)` or `it(name, fn, timeoutMs)`, never `it(name, fn, options)`).
  it(
    'starts a thread, asks and answers a plan-mode question, declines an apply_patch, and exits',
    { timeout: 180_000 },
    async () => {
      const homeDir = os.homedir()
      const descriptors = makeDescriptors(process.platform, homeDir)
      const account: Account = {
        id: 'live-codex',
        label: 'ambient codex',
        configDir: path.join(homeDir, '.codex'),
        color: '#888888',
        createdAt: new Date().toISOString(),
        provider: 'codex'
      }
      const env = cliEnvFor({ base: process.env, account, descriptor: descriptors.codex, homeDir })
      // Vitest does not set it, but a run started from inside Electron would: codex must not be told to
      // behave as node.
      delete env.ELECTRON_RUN_AS_NODE

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

      // 3 — a turn that changes a file. Two outcomes are legitimate (see FILE_PROMPT's note): the server
      // asks us to approve, or Codex's own approval reviewer answers first and we are never asked. What
      // is asserted either way is the part that is this adapter's: the turn reaches idle with nothing
      // left open, and — when we *are* asked — the request decodes to an apply_patch we can decline,
      // after which the file is not there.
      await a.setPlanMode(false)
      await a.send(FILE_PROMPT)
      await until(
        'an approval request, or the turn to finish without one',
        120_000,
        () => a.state().request?.kind === 'approval' || a.state().status === 'idle'
      )
      const approval = a.state().request
      if (approval?.kind === 'approval') {
        expect(approval.about.tool).toBe('apply_patch')
        expect(approval.about.lines.some((l) => l.includes('astera-live-probe.txt'))).toBe(true)
        expect(approval.decisions).toContain('decline')
        await a.answer(approval.id, { kind: 'approval', decision: 'decline' })
        await until('idle after the decline', 120_000, () => a.state().status === 'idle')
        // Read once, remove if present, then assert — so a failure here still leaves the repo clean.
        const wroteAnyway = existsSync(PROBE_FILE)
        if (wroteAnyway) rmSync(PROBE_FILE, { force: true })
        expect(wroteAnyway).toBe(false)
      } else {
        // The reviewer approved it for us; the file is real and this test owns cleaning it up.
        console.log('[live] no approval was asked for — Codex approved the file change itself')
        if (existsSync(PROBE_FILE)) rmSync(PROBE_FILE, { force: true })
      }
      expect(a.state().status).toBe('idle')
      expect(a.state().request).toBeNull()
      expect(existsSync(PROBE_FILE)).toBe(false)

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
