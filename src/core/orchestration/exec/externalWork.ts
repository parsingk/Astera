// The work of a Task by an external agent spoken to over ACP (Phase 5 A1, design "External agent workers"). The dispatch
// loop opens the Dispatch through `external-work-start`, and that command hands it here; the app and the Host build this
// driver alike, and everything that differs between the two processes arrives through `ExternalWorkDeps`, as it does for
// the external review (externalReview.ts), whose rules this run keeps:
// - `setState` is never given a state read before an await: the state is read again right before each commit.
// - Every end that is ours calls `stop` first, so the exit that follows is a consequence and never a cause.
// - A Dispatch closed under the run (a Run stopped, a worker-stop, a reset) and a dispose end it silently: the process is
//   killed and nothing is recorded.
// - A failure is a Gate: the Dispatch ends unproven and the Task is put to a person, who answers to have it worked again.
// - The turn's end is the report: `worker_done` through the same command a worker uses, so validation, review and the
//   completion checks run as they do for any Task.
import path from 'node:path'
import { AcpFailure, killOnce, openAcpSession, type AcpPermissionRequest, type AcpSession } from '../../acp/client'
import { agentChildEnv, resolveAgentCommand } from '../../acp/spawn'
import { isSamePath } from '../../files/tree'
import type { ProcLike } from '../../sessions/proc'
import type { AgentPermissionMode } from '../../types'
import { createGate, endedUnproven, type OrchState } from '../state'
import type { Dispatch } from '../types'
import { specFileName } from './coordinator'
import { EXTERNAL_OPEN_POLL_MS, reviewLogsDir, TRANSCRIPT_MESSAGE_MAX } from './externalReview'
import type { ExternalReviewDeps } from './review'

/** The budget of one external agent's work, counted while it works: a permission question a person has not answered yet
 *  stops the clock (design: no answer leaves it waiting). */
export const EXTERNAL_WORK_TIMEOUT_MS = 60 * 60_000
/** How long one `ask` waits before it is asked again with `--resume`. */
export const EXTERNAL_WORK_ASK_MS = 10 * 60_000
const STDERR_IN_REASON = 600
const AGENT_TEXT_IN_REASON = 300
/** The report's subject is the first line of the agent's message, cut here. */
const SUBJECT_MAX = 120
/** The first line of a message that says the agent could not finish (the brief asks for it). */
const FAILED_MARK = /^\s*FAILED:/

export interface ExternalWorkDeps extends ExternalReviewDeps {
  /** The app-wide `agentPermissionMode`, read at each permission request: `yolo` allows, `manual` asks the person. */
  permissionMode(): Promise<AgentPermissionMode>
  /** Tests shorten one `ask`'s wait. */
  askMs?: number
}

export interface ExternalWorks {
  /** Starts the run of the external agent on a Dispatch `external-work-start` opened. Never throws. */
  start(a: { dispatchId: string }): void
  /** The Dispatches this driver runs now: the orphan close leaves them open. */
  inFlight(): ReadonlySet<string>
  dispose(): void
  idle(): Promise<void>
}

interface Running {
  release(): void
  silent: boolean
  stop(): void
  done: Promise<void>
}

const STOPPED = new Error('stopped')

const isOpenIn = (s: OrchState, dispatchId: string): boolean => {
  const d = s.dispatches.find((x) => x.id === dispatchId)
  return d !== undefined && !d.outcome && !d.endedAt
}

const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
const agentWords = (text: string): string => oneLine(text).slice(0, AGENT_TEXT_IN_REASON)
const errorText = (body: unknown): string => {
  if (typeof body === 'string') return body
  const e = (body as { error?: unknown } | null)?.error
  return typeof e === 'string' ? e : JSON.stringify(body)
}

/** What the external agent reads: the Task, the commit obligation when it works in a worktree, and how its work ends. In
 *  English, as the worker brief is (buildSpecFile): an agent reads it. It has no `astera` command to report with, so its
 *  turn's end is the report. */
export function buildExternalWorkSpec(a: { title: string; spec: string; committing: boolean }): string {
  const commit = a.committing
    ? `
---
## Commit obligation (assembled by Astera, do not delete)

You are working in a git worktree, not in the project folder. When the work is finished you must commit it here:
committing is the only way this work leaves this folder, and whatever you do not commit is thrown away with it.

  git add -A
  git commit -m "<one-line summary of the change>"

Commit before you end your turn.
`
    : ''
  return `# ${a.title}

${a.spec}
${commit}
---
## How this task ends (assembled by Astera, do not delete)

Work until the task is done, then end your turn. The message you end your turn with is your report: its first line is
a one-line status, then a few sentences on what you did, what you found, and what is left. Do not run any command to
report; Astera records the end of your turn.

If you cannot finish the task, begin that message with FAILED: and say why.

When an action needs permission, ask for it as you always do: Astera answers it as this task's permission mode says, or
puts it to the person and waits for their answer.
`
}

/** The option a `yolo` run picks: the narrowest allow, else a reject (an agent that offers no allow is not allowed). */
export function allowOptionOf(req: AcpPermissionRequest): string | null {
  const by = (kind: string): string | undefined => req.options.find((o) => o.kind === kind)?.optionId
  return by('allow_once') ?? by('allow_always') ?? by('reject_once') ?? by('reject_always') ?? null
}

/** The label each option is offered to the person as: its name, else its kind, without the commas `ask` splits on. */
const labelOf = (o: AcpPermissionRequest['options'][number]): string => (o.name ?? o.kind).replace(/,/g, ' ').trim() || o.optionId

/** The option a person's answer picks: the label they chose, or an option id; anything else rejects. */
export function optionForAnswer(req: AcpPermissionRequest, answer: string): string | null {
  const a = answer.trim()
  const hit = req.options.find((o) => labelOf(o) === a) ?? req.options.find((o) => o.optionId === a)
  if (hit) return hit.optionId
  return req.options.find((o) => o.kind === 'reject_once')?.optionId ?? req.options.find((o) => o.kind === 'reject_always')?.optionId ?? null
}

export function createExternalWorks(c: {
  getState(): OrchState
  setState(next: OrchState): Promise<void>
  now(): string
  log(m: string): void
  specsDir: string
  external: ExternalWorkDeps
}): ExternalWorks {
  const ext = c.external
  const running = new Map<string, Running>()
  let disposed = false
  const unregister = (id: string, self: Running): void => {
    if (running.get(id) === self) running.delete(id)
    self.release()
  }
  const abort = (dispatchId: string): void => {
    const r = running.get(dispatchId)
    if (!r) return
    r.silent = true
    r.stop()
  }

  async function run(d: Dispatch, self: Running): Promise<void> {
    const taskId = d.taskId
    const agentId = d.externalAgent?.id ?? ''
    let name = agentId
    let command = agentId
    const specPath = path.join(c.specsDir, specFileName(taskId, d.id))
    const logFile = path.join(reviewLogsDir(c.specsDir), `${taskId}-${d.id}.log`)
    const log = (line: string): void => {
      try {
        ext.appendLog(logFile, `${new Date().toISOString()} ${line}`)
      } catch {
        // a transcript that cannot be written is not a reason to end the work
      }
    }
    const budgetMs = ext.timeoutMs ?? EXTERNAL_WORK_TIMEOUT_MS
    let left = budgetMs
    let clockFrom = 0
    let proc: ProcLike | undefined
    let session: AcpSession | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    let stopped = false
    let timedOut = false

    const stop = (): void => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      if (poll !== undefined) clearInterval(poll)
      timer = poll = undefined
      session?.close()
      proc?.kill()
    }
    self.stop = stop
    /** The budget runs only while the agent works: `pauseClock` keeps what is left while a person is asked. */
    const startClock = (): void => {
      if (stopped || timer !== undefined) return
      clockFrom = Date.now()
      timer = setTimeout(() => {
        timedOut = true
        stop()
      }, Math.max(0, left))
    }
    const pauseClock = (): void => {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
      left -= Date.now() - clockFrom
    }
    const checkpoint = (): void => {
      if (stopped) throw STOPPED
    }
    const dropped = (): boolean => {
      if (self.silent) return true
      if (isOpenIn(c.getState(), d.id)) return false
      log('the Dispatch is not open any more; nothing is recorded')
      return true
    }
    const logTurn = (turn: { stopReason: string; text: string }): void => {
      const cut = turn.text.length > TRANSCRIPT_MESSAGE_MAX
      log(`turn ended: ${turn.stopReason}`)
      const kept = cut ? turn.text.slice(0, TRANSCRIPT_MESSAGE_MAX) : turn.text
      const marker = cut ? `\n[message cut at ${TRANSCRIPT_MESSAGE_MAX} characters, ${turn.text.length - TRANSCRIPT_MESSAGE_MAX} more not kept]` : ''
      log(`agent message:\n${kept}${marker}`)
    }
    /** The one record a failure makes: the Dispatch ends unproven and the Task goes to a person, in one commit read with
     *  no await before it. Answering the Gate makes the Task ready again, and the loop starts the agent once more. */
    const fail = async (reason: string): Promise<void> => {
      stop()
      if (self.silent) return
      log(`failed: ${reason}`)
      const s = c.getState()
      const x = s.dispatches.find((y) => y.id === d.id)
      if (!x || x.outcome || x.endedAt) return void c.log(`external work of task=${taskId} dispatch=${d.id} failed after its Dispatch was closed: ${reason}`)
      const closed: OrchState = { ...s, dispatches: s.dispatches.map((y) => (y.id === d.id ? endedUnproven(y, c.now()) : y)) }
      const gated = createGate(
        closed,
        {
          taskId,
          question: `외부 에이전트가 이 Task 를 끝내지 못했습니다: ${reason}\n기록: ${logFile}\n이 질문에 답하면 Task 가 다시 준비 상태가 되고 같은 에이전트가 다시 맡습니다. 끝난 일을 그대로 닫으려면 task-update --status completed 를 쓰세요.`
        },
        c.now()
      )
      await c.setState(gated.ok ? gated.state : closed)
      if (!gated.ok) c.log(`external work of task=${taskId} dispatch=${d.id}: no Gate could be opened (${gated.error}); its Dispatch is closed as unproven`)
    }
    const reasonOf = (e: unknown): string => {
      if (timedOut) return `the external agent ${name} did not finish in ${Math.max(1, Math.round(budgetMs / 60_000))} minutes.`
      if (e instanceof AcpFailure) {
        switch (e.kind) {
          case 'sign-in':
            return `the external agent ${name} needs a sign-in: ${agentWords(e.message).replace(/\.+$/, '')}. Sign in with that agent's own CLI in a terminal first.`
          case 'exited':
            if (proc !== undefined && proc.pid === 0)
              return `the external agent ${name} could not be started: ${command} was not found. Install it or correct the command in Settings.`
            return `the external agent ${name} stopped before it finished (exit ${/exited with code (-?\d+)/.exec(e.message)?.[1] ?? '?'}): ${(e.stderrTail ?? '').slice(-STDERR_IN_REASON)}`
          default:
            return `the external agent ${name} could not be used: ${agentWords(e.message)}`
        }
      }
      return `the external agent ${name} could not be used: ${agentWords(e instanceof Error ? e.message : String(e))}`
    }

    /** One permission request, decided as the app-wide permission mode says. A Run stopped or a closed Dispatch ends the
     *  wait, and the agent is told it was cancelled. */
    const decide = async (req: AcpPermissionRequest): Promise<string | null> => {
      if (stopped) return null
      let mode: AgentPermissionMode
      try {
        mode = await ext.permissionMode()
      } catch {
        // An unreadable setting is not a permission: the person is asked
        mode = 'manual'
      }
      if (mode === 'yolo') return allowOptionOf(req)
      if (req.options.length === 0) return null
      pauseClock()
      try {
        const labels = req.options.map(labelOf)
        const question = `외부 에이전트 ${name}의 권한 요청: ${req.title ?? req.kind ?? '알 수 없는 작업'}${req.kind && req.title ? ` (${req.kind})` : ''}`
        let questionId: string | undefined
        while (!stopped) {
          let reply: { status: number; body: unknown }
          try {
            reply = await ext.handle('ask', {
              ...(questionId ? { resume: questionId } : { taskId, dispatchId: d.id, question, options: labels.join(',') }),
              timeoutMs: ext.askMs ?? EXTERNAL_WORK_ASK_MS
            })
          } catch (e) {
            log(`permission question could not be asked: ${e instanceof Error ? e.message : String(e)}`)
            return null
          }
          const body = (reply.body ?? {}) as { answered?: boolean; answer?: string; timedOut?: boolean; questionId?: string }
          if (reply.status !== 200) {
            log(`permission question refused: ${errorText(reply.body)}`)
            return null
          }
          if (body.answered === true && typeof body.answer === 'string') return optionForAnswer(req, body.answer)
          if (body.timedOut === true && typeof body.questionId === 'string') {
            questionId = body.questionId
            continue
          }
          // abandoned: the Dispatch ended under the question
          return null
        }
        return null
      } finally {
        startClock()
      }
    }

    try {
      if (!isOpenIn(c.getState(), d.id)) return
      try {
        ext.pruneReviewLogs(reviewLogsDir(c.specsDir))
      } catch (e) {
        c.log(`external agent transcripts could not be pruned: ${String(e)}`)
      }
      let settings
      try {
        settings = await ext.settings()
      } catch (e) {
        return await fail(`the external agent setting could not be read: ${e instanceof Error ? e.message : String(e)}`)
      }
      if (dropped()) return
      const agent = settings.reviewers.find((r) => r.id === agentId)
      if (!agent) return await fail(`the external agent ${agentId} is not registered in Settings, Agents any more. Register it again, or give the Task an account.`)
      name = agent.name
      command = agent.command

      // The brief, and the agent's name on the Dispatch, in one commit read right before it
      const s0 = c.getState()
      const task = s0.tasks.find((t) => t.id === taskId)
      const run0 = task ? s0.runs.find((r) => r.id === task.runId) : undefined
      const job = run0 ? s0.jobs.find((j) => j.id === run0.jobId) : undefined
      if (!task) return
      const prompt = buildExternalWorkSpec({ title: task.title, spec: task.spec, committing: !isSamePath(d.cwd, job?.cwd ?? '') })
      await ext.writeFile(specPath, prompt)
      if (dropped()) return
      const s1 = c.getState()
      await c.setState({ ...s1, dispatches: s1.dispatches.map((x) => (x.id === d.id ? { ...x, specPath, externalAgent: { id: agent.id, name: agent.name } } : x)) })
      log(`task: ${task.title} (${prompt.length} characters of brief)`)

      const resolved = await (ext.resolve ?? resolveAgentCommand)(agent, ext.platform)
      if (dropped()) return
      if (!resolved.ok) return await fail(`the external agent ${name} could not be started: ${resolved.error}`)
      const baseEnv = await ext.env(d.cwd)
      if (dropped()) return
      try {
        proc = killOnce(ext.spawn(resolved.file, resolved.args, { cwd: d.cwd, env: agentChildEnv(baseEnv, ext.platform) }))
      } catch (e) {
        return await fail(`the external agent ${name} could not be started: ${e instanceof Error ? e.message : String(e)}`)
      }
      startClock()
      // A Run stopped, a worker-stop or a reset closes the Dispatch: the work ends without a record
      poll = setInterval(() => {
        if (!isOpenIn(c.getState(), d.id)) abort(d.id)
      }, ext.pollMs ?? EXTERNAL_OPEN_POLL_MS)

      session = await openAcpSession({ proc, cwd: d.cwd, clientVersion: ext.clientVersion, log, worker: { decide } })
      checkpoint()
      log(`agent: ${session.agent.title ?? session.agent.name ?? 'unknown'} ${session.agent.version ?? ''}`.trimEnd())

      const turn = await session.prompt(prompt)
      checkpoint()
      logTurn(turn)
      if (turn.stopReason !== 'end_turn') return await fail(`the external agent ${name} ended its turn with ${agentWords(turn.stopReason)}.`)
      // The turn is the work: the process has nothing more to do and is ended before the report
      stop()
      if (dropped()) return
      // The report is the agent's last message, after its last tool call: what it said before is narration (C1)
      const text = turn.finalText.trim()
      const first = text.split(/\r?\n/, 1)[0] ?? ''
      const failed = FAILED_MARK.test(first)
      let reply: { status: number; body: unknown }
      try {
        reply = await ext.handle('send', {
          type: 'worker_done',
          taskId,
          dispatchId: d.id,
          outcome: failed ? 'failed' : 'succeeded',
          subject: first === '' ? (failed ? 'failed' : 'done') : first.slice(0, SUBJECT_MAX),
          body: text === '' ? `The external agent ${name} ended its turn without a message.` : text
        })
      } catch (e) {
        reply = { status: 500, body: { error: e instanceof Error ? e.message : String(e) } }
      }
      if (reply.status === 200 && (reply.body === 'accepted' || reply.body === 'alreadyReported')) {
        log(`reported: ${failed ? 'failed' : 'succeeded'} (${String(reply.body)})`)
        return
      }
      if (!isOpenIn(c.getState(), d.id)) return void log(`the report was refused (${errorText(reply.body)}) after the Dispatch closed; nothing is recorded`)
      await fail(`the report of the external agent ${name} was refused: ${errorText(reply.body)}`)
    } catch (e) {
      if (self.silent) return
      await fail(reasonOf(e))
    } finally {
      stop()
    }
  }

  return {
    start({ dispatchId }) {
      if (disposed) return void c.log(`external work dispatch=${dispatchId} not started: this driver has been disposed`)
      const d = c.getState().dispatches.find((x) => x.id === dispatchId)
      if (!d || !d.externalAgent || d.outcome || d.endedAt) return void c.log(`external work dispatch=${dispatchId} not started: it is not an open external agent Dispatch`)
      if (running.has(dispatchId)) return
      // Registered before anything awaits: the orphan close counts it from the start
      let release: () => void = () => {}
      const self: Running = { silent: false, stop: () => {}, release: () => release(), done: new Promise<void>((r) => (release = r)) }
      running.set(dispatchId, self)
      c.log(`external work started task=${d.taskId} agent=${d.externalAgent.id} dispatch=${dispatchId}`)
      void run(d, self)
        .catch((e) => c.log(`external work of task=${d.taskId} dispatch=${dispatchId} ended with an error: ${String(e)}`))
        .finally(() => unregister(dispatchId, self))
    },
    inFlight: () => new Set(running.keys()),
    dispose() {
      disposed = true
      for (const id of [...running.keys()]) abort(id)
    },
    async idle() {
      while (running.size > 0) await Promise.all([...running.values()].map((r) => r.done))
    }
  }
}
