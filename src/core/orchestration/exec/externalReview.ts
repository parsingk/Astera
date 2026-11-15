// The review of a Task by an external agent spoken to over ACP (external reviewers design 3.4 to 3.6). Built by
// createReviewStarter for the app and for the Host alike: everything that differs between the two processes arrives
// through ReviewContext, as it does for the automatic review.
//
// Rules that hold in every path below, because a review here is a detached run with a timer, a poll, an exit event and a
// dispose that can interleave:
// - `setState` is never given a state read before an await: the state is read again right before each commit.
// - Every end that is ours (verdict reached, timeout, violation, dispose, a closed Dispatch) calls `stop` first, so the
//   exit that follows is a consequence and never a cause: the ACP client reads its own close() as intentional.
// - A failure is a Gate keyed by this review's Dispatch (`gateDispatch`): it acts only while that Dispatch is still open.
// - A Dispatch closed under the run, and a dispose, end it silently: the process is killed and nothing is recorded.
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { AcpFailure, openAcpSession, type AcpSession } from '../../acp/client'
import { agentChildEnv, resolveAgentCommand } from '../../acp/spawn'
import { isSamePath } from '../../files/tree'
import type { ProcLike } from '../../sessions/proc'
import type { ExternalReviewer } from '../../settings/externalReviewers'
import { policyOf } from '../convergence'
import { openReviewDispatch, workSandboxed, type OrchState } from '../state'
import { EXTERNAL_REVIEW_SESSION_PREFIX, type Dispatch } from '../types'
import type { Provider } from '../../providers/meta'
import { specFileName } from './coordinator'
import { workRanSandboxed } from './checkSandbox'
import { parseExternalVerdict, VERDICT_RETRY_PROMPT, type ExternalVerdict } from './externalVerdict'
import type { ReviewGate } from './reviewGate'
import type { ExternalReviewDeps } from './review'

/** The whole budget of one external review, from the spawn. */
export const EXTERNAL_REVIEW_TIMEOUT_MS = 20 * 60_000
/** How often a running review checks that its Dispatch is still open. */
export const EXTERNAL_OPEN_POLL_MS = 2_000
/** The diff embedded in the reviewer's prompt is cut here. */
export const EXTERNAL_DIFF_MAX_BYTES = 150_000
const STDERR_IN_REASON = 600

export interface ExternalReviewStart {
  taskId: string
  reviewer: ExternalReviewer
  cwd: string
  /** The implementer's provider: recorded on the Dispatch only because the type requires one. */
  implProvider: Provider
  /** The prompt, once the Dispatch (and so its id) exists. `resultPath` is given in a convergence Run only. */
  buildPrompt(a: { dispatchId: string; resultPath?: string }): Promise<string>
  /** A failure before any review Dispatch exists (reviewGate.gate). */
  gate(reason: string): Promise<void>
}

export interface ExternalReviews {
  start(a: ExternalReviewStart): Promise<void>
  inFlight(): ReadonlySet<string>
  dispose(): void
  idle(): Promise<void>
}

interface Running {
  /** Set by an end that records nothing (dispose, a closed Dispatch): every later commit is dropped. */
  silent: boolean
  stop(): void
  done: Promise<void>
}

/** Thrown at a checkpoint once the run has been stopped. */
const STOPPED = new Error('stopped')

const isOpenIn = (s: OrchState, dispatchId: string): boolean => {
  const d = s.dispatches.find((x) => x.id === dispatchId)
  return d !== undefined && !d.outcome && !d.endedAt
}

const firstLine = (text: string): string => text.split(/\r?\n/, 1)[0]

const errorText = (body: unknown): string => {
  if (typeof body === 'string') return body
  const e = (body as { error?: unknown } | null)?.error
  return typeof e === 'string' ? e : JSON.stringify(body)
}

export function createExternalReviews(c: {
  getState(): OrchState
  setState(next: OrchState): Promise<void>
  now(): string
  log(m: string): void
  assertAllowedPath(p: string): Promise<string>
  specsDir: string
  external: ExternalReviewDeps
  reviewGate: ReviewGate
}): ExternalReviews {
  const ext = c.external
  const running = new Map<string, Running>()

  /** The one way a review ends without recording anything. */
  const abort = (dispatchId: string, record: false): void => {
    const r = running.get(dispatchId)
    if (!r || record) return
    r.silent = true
    r.stop()
  }

  async function run(d: Dispatch, a: ExternalReviewStart, self: Running): Promise<void> {
    const { reviewer, taskId, cwd } = a
    const name = reviewer.name
    const specPath = path.join(c.specsDir, specFileName(taskId, d.id))
    const logFile = `${specPath}.acp.log`
    const log = (line: string): void => {
      try {
        ext.appendLog(logFile, `${new Date().toISOString()} ${line}`)
      } catch {
        // a transcript that cannot be written is not a reason to end the review
      }
    }
    const timeoutMs = ext.timeoutMs ?? EXTERNAL_REVIEW_TIMEOUT_MS
    let proc: ProcLike | undefined
    let session: AcpSession | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    let stopped = false
    let timedOut = false

    /** Ends the run on purpose and kills the process. Idempotent; synchronous. */
    const stop = (): void => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      if (poll !== undefined) clearInterval(poll)
      timer = poll = undefined
      session?.close()
      proc?.kill()
    }
    self.stop = stop
    const checkpoint = (): void => {
      if (stopped) throw STOPPED
    }
    /** After an end of ours that follows a verdict: nothing is recorded for a Dispatch that is not open any more. */
    const dropped = (): boolean => {
      if (self.silent) return true
      if (isOpenIn(c.getState(), d.id)) return false
      log('the Dispatch is not open any more; nothing is recorded')
      return true
    }
    const fail = async (reason: string): Promise<void> => {
      stop()
      if (self.silent) return
      log(`failed: ${reason}`)
      const gated = await c.reviewGate.gateDispatch({ taskId, dispatchId: d.id, reason })
      if (!gated) c.log(`external review of task=${taskId} dispatch=${d.id} failed after its Dispatch was closed: ${reason}`)
    }
    const reasonOf = (e: unknown): string => {
      if (timedOut) return `the external reviewer ${name} did not finish in ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes.`
      if (e instanceof AcpFailure) {
        switch (e.kind) {
          case 'sign-in':
            return `the external reviewer ${name} needs a sign-in: ${e.message}. Run ${reviewer.command} in a terminal once and sign in, then review again.`
          case 'exited':
            // A process that never had a pid was not started at all
            if (proc !== undefined && proc.pid === 0)
              return `the external reviewer ${name} could not be started: ${reviewer.command} was not found. Install it or correct the command in Settings.`
            return `the external reviewer ${name} stopped before giving a verdict (exit ${/exited with code (-?\d+)/.exec(e.message)?.[1] ?? '?'}): ${(e.stderrTail ?? '').slice(-STDERR_IN_REASON)}`
          case 'violation':
            return `the external reviewer ${name} changed a file without asking (${e.message}). Its verdict is not used. Check the folder, and set the agent so that it asks before editing.`
          default:
            return `the external reviewer ${name} could not be used: ${e.message}`
        }
      }
      return `the external reviewer ${name} could not be used: ${e instanceof Error ? e.message : String(e)}`
    }
    /** A Dispatch other than this one worked in the folder during the review: open now, or ended after it began. */
    const othersWorked = (): boolean =>
      c.getState().dispatches.some(
        (x) => x.id !== d.id && isSamePath(x.cwd, cwd) && ((!x.outcome && !x.endedAt) || (x.endedAt !== undefined && x.endedAt > d.startedAt))
      )

    try {
      // Nothing of the run's own is going yet, so a closed Dispatch is simply not started
      if (!isOpenIn(c.getState(), d.id)) return
      const convergence = ((): boolean => {
        const s = c.getState()
        const t = s.tasks.find((x) => x.id === taskId)
        return t !== undefined && policyOf(s, t) !== null
      })()
      const resultPath = `${specPath}.review.json`
      const prompt = await a.buildPrompt({ dispatchId: d.id, ...(convergence ? { resultPath } : {}) })
      await ext.writeFile(specPath, prompt)
      if (dropped()) return
      const latest = c.getState()
      await c.setState({ ...latest, dispatches: latest.dispatches.map((x) => (x.id === d.id ? { ...x, specPath } : x)) })
      log(`prompt: ${firstLine(prompt).slice(0, 200)} (${prompt.length} characters)`)

      const before = await ext.treeState(cwd)
      if (dropped()) return
      const resolved = await (ext.resolve ?? resolveAgentCommand)(reviewer, ext.platform)
      if (dropped()) return
      if (!resolved.ok) return await fail(`the external reviewer ${name} could not be started: ${resolved.error}`)

      // The budget and the poll start with the process; both are cleared by `stop`, which every end calls
      try {
        proc = ext.spawn(resolved.file, resolved.args, { cwd, env: agentChildEnv(ext.baseEnv()) })
      } catch (e) {
        return await fail(`the external reviewer ${name} could not be started: ${e instanceof Error ? e.message : String(e)}`)
      }
      timer = setTimeout(() => {
        timedOut = true
        stop()
      }, timeoutMs)
      poll = setInterval(() => {
        if (isOpenIn(c.getState(), d.id)) return
        abort(d.id, false)
      }, ext.pollMs ?? EXTERNAL_OPEN_POLL_MS)

      session = await openAcpSession({ proc, cwd, clientVersion: ext.clientVersion, log })
      checkpoint()
      log(`agent: ${session.agent.title ?? session.agent.name ?? 'unknown'} ${session.agent.version ?? ''}`.trimEnd())

      let turn = await session.prompt(prompt)
      checkpoint()
      log(`turn ended: ${turn.stopReason}`)
      let verdict: ExternalVerdict | undefined
      for (let attempt = 0; verdict === undefined; attempt++) {
        if (turn.stopReason !== 'end_turn') return await fail(`the external reviewer ${name} ended its turn with ${turn.stopReason}.`)
        const parsed = parseExternalVerdict(turn.text)
        if (parsed.ok) verdict = parsed.verdict
        else if (attempt === 1) return await fail(`the external reviewer ${name} ended without a readable verdict: ${parsed.error}`)
        else {
          log(`no readable verdict (${parsed.error}); asking once more`)
          turn = await session.prompt(VERDICT_RETRY_PROMPT)
          checkpoint()
          log(`turn ended: ${turn.stopReason}`)
        }
      }

      // The verdict is in: the process has nothing more to say and is ended before anything is judged. The exit that
      // follows is not read as a failure (`stop` marks the end first), and the budget and the poll are over.
      stop()
      log(`verdict: ${verdict.outcome}, ${verdict.issues.length} issue(s)`)

      const after = await ext.treeState(cwd)
      if (dropped()) return
      if (before !== null && after !== null && before !== after) {
        if (othersWorked()) log('folder check skipped: another Dispatch worked in the folder during the review')
        else return await fail(`files in ${cwd} changed while the external reviewer ${name} ran. Its verdict is not used.`)
      }

      if (convergence) {
        await ext.writeFile(resultPath, JSON.stringify({ issues: verdict.issues }))
        if (dropped()) return
      }
      const summary = verdict.summary
      let reply: { status: number; body: unknown }
      try {
        reply = await ext.handle('send', {
          type: 'worker_done',
          taskId,
          dispatchId: d.id,
          outcome: verdict.outcome === 'approved' ? 'succeeded' : 'failed',
          subject: summary.trim() === '' ? verdict.outcome : firstLine(summary.trim()).slice(0, 120),
          body: summary
        })
      } catch (e) {
        reply = { status: 500, body: { error: e instanceof Error ? e.message : String(e) } }
      }
      if (reply.status === 200 && (reply.body === 'accepted' || reply.body === 'alreadyReported')) {
        log(`settled: ${String(reply.body)}`)
        return
      }
      await fail(`the verdict of the external reviewer ${name} was refused: ${errorText(reply.body)}`)
    } catch (e) {
      // A dispose or a closed Dispatch records nothing; the stop they made is what rejected the pending call
      if (self.silent) return
      await fail(reasonOf(e))
    } finally {
      stop()
    }
  }

  return {
    async start(a) {
      // **A read of the state is not carried across an await** (review.ts says why): this one is used before the next one
      const st = c.getState()
      const task = st.tasks.find((t) => t.id === a.taskId)
      if (task?.status !== 'reviewing') return
      if (workRanSandboxed(st, task) || workSandboxed(st, task))
        return void (await a.gate(
          `this task's work ran in a sandbox, and the external reviewer ${a.reviewer.name} cannot be sandboxed. Set the reviewer to Automatic in Settings, or complete the task by hand.`
        ))
      await c.assertAllowedPath(a.cwd)
      const fresh = c.getState()
      if (fresh.tasks.find((t) => t.id === a.taskId)?.status !== 'reviewing') return
      const opened = openReviewDispatch(
        fresh,
        {
          taskId: a.taskId,
          provider: a.implProvider,
          accountId: '',
          sessionId: `${EXTERNAL_REVIEW_SESSION_PREFIX}${randomBytes(4).toString('hex')}`,
          cwd: a.cwd,
          specPath: '',
          externalReviewer: { id: a.reviewer.id, name: a.reviewer.name }
        },
        c.now()
      )
      // `dispatch already open` is not a failure (reviewGate.onOpenRefused says why)
      if (!opened.ok) return void (await c.reviewGate.onOpenRefused({ taskId: a.taskId, error: opened.error }))
      await c.setState(opened.state)
      c.log(`external review started task=${a.taskId} reviewer=${a.reviewer.name} dispatch=${opened.value.id}`)
      // The rest runs detached; whatever it throws ends in a Gate or in the log, never in the caller
      const self: Running = { silent: false, stop: () => {}, done: Promise.resolve() }
      running.set(opened.value.id, self)
      self.done = run(opened.value, a, self)
        .catch((e) => c.log(`external review of task=${a.taskId} dispatch=${opened.value.id} ended with an error: ${String(e)}`))
        .finally(() => {
          if (running.get(opened.value.id) === self) running.delete(opened.value.id)
        })
    },
    inFlight: () => new Set(running.keys()),
    dispose() {
      for (const id of [...running.keys()]) abort(id, false)
    },
    async idle() {
      while (running.size > 0) await Promise.all([...running.values()].map((r) => r.done))
    }
  }
}
