// Dispatch execution. Brings up a session (or reuses one via --terminal) and writes the spec file.
//
// **The server owns OrchState. The coordinator neither reads nor writes state at all.**
// openDispatch and closeDispatch now live only in server.ts — the server creates the dispatchId up
// front and passes it in as an argument, and on failure the coordinator simply throws (cleanup is
// the server's job). handleExit (where closeDispatch used to be called) touches state too, so it
// moved to server.ts as well.
//
// The first injection hands the spec file path over as a CLI positional argument; a reuse
// (--terminal) injects it with a PTY write. A positional argument needs no readiness detection.
//
// The spec file is written **outside the user's repository** — into the injected specsDir (the
// wiring passes <userData>/orch/specs). It used to sit inside the worker cwd, but the spec body
// carries the work instructions the orchestrator wrote, and leaving it in the user's repository
// makes it show up in git status and leak once committed.
// The path is injected so that this class does not depend on the Electron app (it stays purely
// testable).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Provider } from '../../core/providers/meta'

export interface CoordinatorDeps {
  spawnSession(o: {
    accountId: string
    cwd: string
    bypassPermissions?: boolean
    initialPrompt: string
    /** Title of the worker tab = task.title. Deliberately not optional — the coordinator always has
     *  a title (it is a required argument of startWorker), and if it were optional the wiring could
     *  omit it and still compile. */
    title: string
  }): Promise<{ id: string }>
  writeToSession(sessionId: string, data: string): void
  /** Is that session working. **null = it cannot be decided for this provider** (codex — a
   *  decorative spinner keeps running in the window title and child processes overwrite the title,
   *  which makes the signal meaningless; measured directly). The coordinator does not need to know
   *  which providers can be decided — the wiring knows that. */
  isBusy(sessionId: string): boolean | null
  /** Is that session still alive (the reuse target). SessionManager.write does not throw on a dead
   *  session, it silently no-ops (core/sessions/manager.ts) — which is why the reuse path has to
   *  check this first, before injecting. Otherwise the prompt goes nowhere and the Task stays locked
   *  with worker_done never arriving. */
  isAlive(sessionId: string): boolean
  killSession(sessionId: string): void
  createWorktree(a: { repoPath: string; name: string }): Promise<{ path: string }>
  accountProvider(accountId: string): Provider | null
  /** Directory to write spec files into (absolute path). It has to be outside the user's repository
   *  — the spec body carries the work instructions the orchestrator wrote, and inside the repository
   *  it would leak once committed. The wiring passes `<userData>/orch/specs` (the same convention as
   *  `statusline/`). */
  specsDir: string
  /** Diagnostic log for things such as exceeding the idle wait limit. The wiring decides where it goes (console, file, ...) */
  log(message: string): void
  /** Limit on waiting for the busy -> idle transition (ms). Defaults to 30s
   *  (DEFAULT_IDLE_WAIT_TIMEOUT_MS) — tests inject a short value so they do not depend on timing. */
  idleWaitTimeoutMs?: number
}

/** Characters that break quoting under win32's cmd.exe /c wrapping if they reach the launch prompt */
export const LAUNCH_FORBIDDEN = /["&|<>^%]/
/** Gap between the prompt and Enter when injecting into a reused session. Same value as rolling and the scheduler */
const ENTER_DELAY_MS = 150
/** Polling interval while waiting for the busy -> idle transition. Same value as the server's check/ask polling (POLL_MS) */
const IDLE_POLL_MS = 50
/** Default limit for waitUntilIdle. BusyScanner.busy (core/terminal/busy.ts) is a sticky value that
 *  only updates when a new, complete OSC title arrives — if the last complete title was a busy frame
 *  and nothing repaints after it, it can stay true forever. An unbounded wait would then hold this
 *  function forever, the worker-start HTTP response above it would never finish either, and one of
 *  the orchestrator's shell commands would hang with no output. 30s is generous compared to a normal
 *  busy frame (a few seconds) while still always elapsing before the user's next turn starts. */
const DEFAULT_IDLE_WAIT_TIMEOUT_MS = 30_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** specPath is an absolute path normalized to forward slashes (see startWorker below) */
export const launchPrompt = (specPath: string): string =>
  `Read ${specPath} and follow the instructions in it`

export function buildSpecFile(a: {
  title: string
  spec: string
  taskId: string
  dispatchId: string
}): string {
  return `# ${a.title}

${a.spec}

---
## Reporting obligation (assembled by the app — do not delete)

When the work is finished you must run the following exactly once to report. Without a report the
orchestrator has no way to know how this task ended.

If \`astera\` in the commands below comes back as command not found, call it as \`"$ASTERA_CLI"\`
instead — that is the absolute path to the same program, and the variable is always present in this
session.

  astera send --type worker_done \\
    --task-id ${a.taskId} --dispatch-id ${a.dispatchId} \\
    --outcome succeeded --subject "<one-line status>" --body - \\
    --files-modified "path/a,path/b" --json
  (body through stdin: three sentences on what you did, what you found, and what is left)

Failure is a terminal report too — use --outcome failed.
Do not record a failure in the body alone.

After reporting, end your turn and wait at the agent prompt. Do not start more work and do not close
the terminal yourself. If the orchestrator reuses this terminal, new instructions arrive as input.

### When stuck — ask (blocking)

If a judgement call, missing information, or a permissions problem is preventing progress, do not
guess:

  astera ask --task-id ${a.taskId} --dispatch-id ${a.dispatchId} \\
    --question - --options "<choice1,choice2>" --json

It blocks until an answer arrives. On {"answered": true, "answer": "…"}, proceed accordingly. On
{"timedOut": true} the question is still alive, so do not ask again — keep waiting with the command
below, as many times as needed.

  astera ask --resume <questionId> --json

If ownership is still valid but the orchestrator needs to step in (notify without blocking):

  astera send --type escalation --task-id ${a.taskId} \\
    --dispatch-id ${a.dispatchId} --subject "<summary>" --body - --json

Do not copy the code itself into the body — you share a working directory with the orchestrator.
For files you changed, give the paths through --files-modified.
`
}

/** 검토 워커의 spec 파일. buildSpecFile 의 형제이고, 다른 것은 두 가지다 — 판정 기준이 원래 Task 의
 *  요구라는 것, 그리고 **코드를 바꾸지 말라는 것.**
 *
 *  검토자가 고치기 시작하면 그것은 구현이고 그 변경은 아무도 검증하지 않는다: 검증은 이미 지나갔고
 *  검토자를 검토하는 층은 없다. */
export function buildReviewSpecFile(a: {
  title: string
  spec: string
  taskId: string
  dispatchId: string
  implReport?: string
  filesModified?: string[]
  /** 검증 구성이 걸려 있었고 통과했는가. 검토자가 컴파일·테스트를 다시 판정하지 않게 하는 근거다 */
  validated: boolean
}): string {
  return `# Review: ${a.title}

You are reviewing work another agent finished. **Do not change any code.** Read, judge, report.

## The requirement this work has to satisfy

${a.spec}

## What the implementer reported

${a.implReport?.trim() || '(nothing was reported)'}

## Files the implementer says it changed

${a.filesModified?.length ? a.filesModified.map((f) => `- ${f}`).join('\n') : '(none reported)'}

## What is already decided — do not re-judge it

${
  a.validated
    ? 'The project\'s own build/test configuration was run against this work and it passed. Whether the code compiles and the tests run is settled.'
    : 'No automated validation was attached to this task, so nothing has been proven about the build or the tests. Say so in your report if that matters for the requirement, but do not run the build yourself — that is not what you were started for.'
}

## The one question you answer

**Was the requirement above satisfied?** Not "is this the code I would have written", not "could this be
structured better" — those are not grounds for rejecting the work, because a rejection sends this task
back through the retry flow and a third rejection breaks the circuit and stops the whole dependency
subtree behind it.

Reject when the work does not do what was asked: a missing case, a requirement addressed in name only, a
change that contradicts the spec. Say concretely what is missing, because your body text is the only
record the next attempt gets.

---
## Reporting obligation (assembled by the app — do not delete)

When you have made your judgement you must run the following exactly once. Without a report the task
stays in \`reviewing\` and nothing moves.

If \`astera\` in the commands below comes back as command not found, call it as \`"$ASTERA_CLI"\`
instead — that is the absolute path to the same program, and the variable is always present in this
session.

  astera send --type worker_done \\
    --task-id ${a.taskId} --dispatch-id ${a.dispatchId} \\
    --outcome succeeded --subject "<one-line verdict>" --body - <<'EOF'
  <why the requirement is satisfied>
  EOF

Use \`--outcome failed\` instead when it is not satisfied, and put what is missing in the body.
`
}

export class OrchCoordinator {
  private readonly idleWaitTimeoutMs: number

  constructor(private deps: CoordinatorDeps) {
    this.idleWaitTimeoutMs = deps.idleWaitTimeoutMs ?? DEFAULT_IDLE_WAIT_TIMEOUT_MS
  }

  /** Polls while isBusy is true. null (cannot be decided) and false (idle) pass through immediately
   *  — the tri-state branch lives in this one place only (no per-provider branching in the
   *  coordinator). Past the limit it does not give up, it just injects anyway — the point is to
   *  reduce the chance of colliding with the user's input, not to prevent the injection itself (an
   *  unbounded wait would leave the caller's worker-start permanently unfinished). */
  private async waitUntilIdle(sessionId: string): Promise<void> {
    const deadline = Date.now() + this.idleWaitTimeoutMs
    while (this.deps.isBusy(sessionId) === true) {
      if (Date.now() >= deadline) {
        this.deps.log(
          `orch: idle wait timed out after ${this.idleWaitTimeoutMs}ms for session=${sessionId} — injecting anyway`
        )
        return
      }
      await sleep(IDLE_POLL_MS)
    }
  }

  /**
   * The server has already created the dispatchId (after committing openDispatch) and passes it in —
   * this method never touches OrchState and only produces side effects such as the session process,
   * the worktree and the spec file. On failure it simply throws — cleaning up the state (the
   * rollback) is the server's job.
   */
  async startWorker(a: {
    dispatchId: string
    taskId: string
    title: string
    spec: string
    provider: Provider
    accountId: string
    /** Run.cwd — the base cwd when worktree is 'current'. The server reads it from state and passes it in */
    runCwd: string
    worktree: string
    name?: string
    terminal?: string
    /** cwd, provider and accountId of the dispatch being reused. Used only when --terminal is given.
     *  The server is the one that knows about the previous dispatch (the coordinator does not read
     *  state). */
    terminalCwd?: string
    terminalProvider?: Provider
    terminalAccountId?: string
  }): Promise<{ sessionId: string; cwd: string; specPath: string }> {
    const actual = this.deps.accountProvider(a.accountId)
    if (actual === null) throw new Error(`unknown account: ${a.accountId}`)
    if (actual !== a.provider)
      throw new Error(`account provider mismatch: account is ${actual}, --agent is ${a.provider}`)

    if (a.terminal) {
      // A reuse cannot inject under a provider or account different from the one actually running in
      // that terminal — this blocks mismatches such as recording a claude-account dispatch against a
      // codex terminal.
      if (a.terminalProvider !== undefined && a.terminalProvider !== a.provider)
        throw new Error(
          `terminal provider mismatch: terminal is ${a.terminalProvider}, --agent is ${a.provider}`
        )
      if (a.terminalAccountId !== undefined && a.terminalAccountId !== a.accountId)
        throw new Error(
          `terminal account mismatch: terminal is ${a.terminalAccountId}, --account is ${a.accountId}`
        )
    }

    // The LAUNCH_FORBIDDEN check runs before any side effect (creating the worktree, writing the spec
    // file) — it throws before anything has been touched. It used to run after the worktree was
    // created, which was too late. **The reason it can be computed here has changed**: it used to be
    // because the prompt was built only from taskId and dispatchId (hex ids the app generates), and
    // now it is because **specsDir is an injected value too and so is known up front**.
    //
    // In exchange, this check can now actually fire — the prompt contains a <userData> absolute path
    // and that path contains the username (a Windows username may contain `&` or `^`). So the error
    // has to point at the cause, and the wiring runs the same check at boot to leave a warning
    // (ipc.ts bootOrch).
    const specName = `${a.taskId}-${a.dispatchId}.md`
    const specPath = path.join(this.deps.specsDir, specName)
    // Backslashes become forward slashes: the worker also handles this path through its Bash tool,
    // and `\` is the shell's escape character (the lesson the sh shuttle taught — the same rule as
    // forSh in shuttle.ts). `C:/Users/...` works with both the Windows API and bash. specPath itself
    // (the path the file is written to) is left as is.
    const prompt = launchPrompt(specPath.replace(/\\/g, '/'))
    const forbidden = prompt.match(LAUNCH_FORBIDDEN)
    if (forbidden)
      throw new Error(
        `launch prompt contains forbidden character ${forbidden[0]} — it comes from the spec ` +
          `directory path (specsDir=${this.deps.specsDir}); win32 cmd.exe /c wrapping breaks ` +
          `quoting on ["&|<>^%]`
      )

    let cwd: string
    if (a.terminal) {
      // For a reuse the session's own cwd is used as is — a session cannot be moved
      if (!a.terminalCwd) throw new Error(`unknown terminal: ${a.terminal}`)
      cwd = a.terminalCwd
      if (!this.deps.isAlive(a.terminal))
        throw new Error(`terminal session is not alive: ${a.terminal}`)
    } else if (a.worktree === 'new') {
      if (!a.name) throw new Error('--name is required for --worktree new')
      cwd = (await this.deps.createWorktree({ repoPath: a.runCwd, name: a.name })).path
    } else if (a.worktree === 'current') {
      cwd = a.runCwd
    } else {
      // A worktree given as a path (an arbitrary string the orchestrator LLM produced) — check that
      // it exists first. If the fs.mkdir({recursive:true}) below materialized the parents as well it
      // would defeat SessionManager's CWD_MISSING guard (core/sessions/manager.ts:62) and let a
      // worker boot in an empty directory that is not a repository.
      const stat = await fs.stat(a.worktree).catch(() => null)
      if (!stat || !stat.isDirectory())
        throw new Error(`worktree path does not exist: ${a.worktree}`)
      cwd = a.worktree
    }

    // specPath has nothing to do with cwd (it was settled above) — the wiring creates this directory
    // at boot, but the user can delete it in the meantime, so the mkdir stays.
    await fs.mkdir(path.dirname(specPath), { recursive: true })
    await fs.writeFile(
      specPath,
      buildSpecFile({ title: a.title, spec: a.spec, taskId: a.taskId, dispatchId: a.dispatchId }),
      'utf8'
    )

    let finalSessionId = a.terminal ?? ''
    if (a.terminal) {
      await this.waitUntilIdle(a.terminal)
      this.deps.writeToSession(a.terminal, prompt)
      await sleep(ENTER_DELAY_MS)
      this.deps.writeToSession(a.terminal, '\r')
    } else {
      // bypassPermissions is not passed — the choice is between a worker stalling on a permission
      // prompt and skipping the permission check on the orchestrator's word alone, and that was
      // never decided. The default (not passing it, so the worker stalls if a permission prompt
      // appears) is the safer side of unauthorized execution, so it is left alone.
      const spawned = await this.deps.spawnSession({
        accountId: a.accountId,
        cwd,
        initialPrompt: prompt,
        // The tab title is task.title (no UI change, only the title) — without it the worker tab
        // comes up under the worktree basename and the user cannot tell which task it is
        title: a.title
      })
      finalSessionId = spawned.id
    }

    return { sessionId: finalSessionId, cwd, specPath }
  }

  /** Deciding whether that session may be closed (whether it is retained, whether this is the latest
   *  owner of a reused session) is done up front by the server, which can see the state — the
   *  coordinator only receives the verdict and calls killSession (the principle that the coordinator
   *  does not read state). */
  async releaseWorker(a: {
    sessionId: string
    /** Cleanup held back at the user's request (worker-retain) */
    retained: boolean
    /** Is this dispatch the most recent one that owns this sessionId. A reused session is owned by a
     *  more recent dispatch, so closing it when this is not that dispatch kills someone else's
     *  worker. */
    isLatestOwner: boolean
  }): Promise<void> {
    if (a.retained) {
      // Not skipped silently — there used to be neither a log nor anything in the response, so the
      // state where the session is alive while the orchestrator believes it was cleaned up left no
      // trace at all. Signalling it in the response is the server's job (skipped:'retained' for
      // worker-release, 409 for worker-stop).
      this.deps.log(`orch: release skipped — retained dispatch, session=${a.sessionId} is left alive`)
      return
    }
    if (!a.isLatestOwner) return
    this.deps.killSession(a.sessionId)
  }
}
