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
import { isSamePath } from '../../core/files/tree'
import type { Provider } from '../../core/providers/meta'
import { KNOWLEDGE_DIRS, knowledgeFilesFrom, type KnowledgeFiles } from '../../core/knowledge/detect'

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

/** Limit on the whole knowledgeIn scan (below). The scan is a handful of readdir calls on local
 *  disk — sub-millisecond in the healthy case — so 2s is far past anything a working repository
 *  should ever hit. If six directory listings cannot finish inside that, the knowledge section is
 *  not worth delaying a worker launch for. */
const KNOWLEDGE_SCAN_TIMEOUT_MS = 2_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** specPath is an absolute path normalized to forward slashes (see startWorker below) */
export const launchPrompt = (specPath: string): string =>
  `Read ${specPath} and follow the instructions in it`

/** 워커가 일할 폴더에서 지식 파일을 모은다.
 *
 *  **Exported for testing.** This is the only code in the knowledge feature that touches the
 *  filesystem. The relative-path requirement must be protected by automated tests — a one-off
 *  manual scan cannot preserve the failure case. Do not remove this export.
 *
 *  **`runCwd` 가 아니라 워커의 `cwd` 를 훑는다.** 워크트리는 같은 저장소의 다른 체크아웃이므로 그
 *  파일들이 거기에도 있고, 그 트리에서 얻은 경로여야 워커가 자기가 고칠 코드와 같은 트리의 결정을
 *  읽는다.
 *
 *  **읽지 못하면 빈 목록이다.** 권한이 없거나 경로가 사라졌을 때 지식을 못 읽는 것이 워커를 못
 *  띄우는 이유가 되어서는 안 된다 — loadRunConfigs(main/run/prepare.ts)가 readdir 실패를 같은
 *  방식으로 접는다.
 *
 *  깊이는 관례 디렉터리 자신과 그 바로 아래 한 층까지다. 이 저장소의 knowledge/ 가 그 모양이고
 *  (README.md 는 바로 아래, decisions/*.md 는 한 층 더) docs/adr/ 은 평평하다. 더 깊이 들어가면
 *  큰 저장소에서 비용이 예측되지 않는다.
 *
 *  **이 함수는 launch 경로 위에 있다 — startWorker 가 세션을 띄우기(spawnSession) 전에 이 함수를
 *  기다린다.** 네트워크 마운트가 멈춰 있으면 그만큼 launch 가 늦어지고, readdir 중 하나가 끝내
 *  반환하지 않으면 startWorker 자체가 반환하지 않는다. 그러면 server.ts 의 handleCommand 안
 *  worker-start 분기가 startWorker 호출을 감싸 둔 실패 rollback(catch) 도 돌 기회를 못 얻는다 —
 *  그 rollback 이 있는 이유가 바로 "dispatched 에서 실패하면 재시도할 길이 없다"(dispatched Task
 *  는 --ready 목록에 나오지 않는다)였는데, catch 조차 못 돌면 Task 는 그 무엇에도 잡히지 않고
 *  그대로 박힌다 — 사람이 손으로 task-update 를 칠 때까지.
 *
 *  **그래서 훑기 전체를 KNOWLEDGE_SCAN_TIMEOUT_MS 로 묶는다(race, 아래).** 예전에는 이 함수도
 *  loadRunConfigs(main/run/prepare.ts), jdkScanner, dotnetScanner, core/history/strategies 의
 *  codex.ts·claude.ts 를 근거로 제한을 두지 않았다 — 그것들도 readdir 를 하나같이 제한 없이
 *  부르니까. 하지만 그 넷은 다른 부류다: 전부 **사람이 켠 작업**이다. 설정 화면을 열거나 목록을
 *  조회할 때만 도는 코드라, 멈춰도 사람이 보는 스피너로 나타나고 그 사람이 자리를 뜨면 그만이다.
 *  이 함수는 반대로 **스케줄러의 경로** 위, 워커를 띄울 때마다 지켜보는 사람 없이 돈다 — 멈추면
 *  바로 위 문단이 적은 실패가 그대로 일어난다. 이 파일 안에 이미 같은 이유로 시간 제한을 둔 자리가
 *  있다 — DEFAULT_IDLE_WAIT_TIMEOUT_MS 의 주석이 적은 그대로, 제한 없는 대기는 함수를 영원히
 *  붙들고 그 위의 셸 명령을 출력 없이 매달아 둔다. 같은 논리가 여기에도 적용된다.
 *
 *  시간을 넘기면 지식이 없는 저장소가 받는 것과 같은 값(knowledgeFilesFrom([]))을 돌려준다 —
 *  그리고 그 사실을 log 로 남긴다. 로그가 없으면 시간 초과로 빠진 절과 원래 지식이 없는 저장소를
 *  구별할 방법이 없어, 누군가 증거 없이 사라진 절을 쫓아다니게 된다.
 *
 *  **KNOWLEDGE_MAX 만큼 모았다고 훑기를 멈추지 않는다.** docs/architecture/ 아래 서브디렉터리가
 *  500개면 40개를 채운 뒤로도 나머지 460번을 계속 읽는다는 뜻이지만, 채워지는 대로 멈추면 "어느
 *  파일이 살아남는가"가 readdir 가 돌려주는 순서 — 플랫폼과 파일시스템이 정하는, 이 코드가 통제할
 *  수 없는 순서 — 에 달리게 된다. 그러면 같은 저장소가 실행마다 다른 spec 을 받는다. 다 모아서
 *  순수 계층(knowledgeFilesFrom)이 정렬하고 자르게 하는 것이 결정성을 지키는 유일한 방법이다.
 *  누군가 이것을 "최적화"하려 들 것이다 — 그 전에 이 문단을 읽으라고 남긴다. */
export async function knowledgeIn(
  cwd: string,
  log: (message: string) => void
): Promise<KnowledgeFiles> {
  const scan = (async (): Promise<KnowledgeFiles> => {
    const found: string[] = []
    for (const dir of KNOWLEDGE_DIRS) {
      const entries = await fs
        .readdir(path.join(cwd, dir), { withFileTypes: true })
        .catch(() => null)
      if (!entries) continue // 그 관례를 쓰지 않는 저장소다 — 흔한 경우이고 오류가 아니다
      for (const e of entries) {
        // 경로는 항상 슬래시로 적는다 — spec 을 읽는 것이 사람이 아니라 에이전트이고, win32 의
        // 역슬래시는 그 글에서 이스케이프로 읽힐 수 있다
        if (e.isFile()) found.push(`${dir}/${e.name}`)
        else if (e.isDirectory()) {
          const inner = await fs
            .readdir(path.join(cwd, dir, e.name), { withFileTypes: true })
            .catch(() => null)
          if (!inner) continue // 한 층 아래를 못 읽으면 그것만 건너뛴다
          for (const f of inner) if (f.isFile()) found.push(`${dir}/${e.name}/${f.name}`)
        }
      }
    }
    return knowledgeFilesFrom(found)
  })()

  // 훑기 전체를 하나로 묶어 race 한다 — readdir 호출마다 따로 타이머를 걸면 여섯 번이 곱해져
  // KNOWLEDGE_SCAN_TIMEOUT_MS 하나로는 전체 예산을 표현할 수 없다. 진 쪽이 남아도 다음 turn에
  // fs 콜백이 다시 도는 것은 해가 없다 — found 는 이 스코프에 갇혀 있고 아무도 그 결과를 읽지 않는다.
  let timer!: ReturnType<typeof setTimeout>
  const timedOut = new Promise<KnowledgeFiles>((resolve) => {
    timer = setTimeout(() => {
      log(
        `orch: knowledge scan timed out after ${KNOWLEDGE_SCAN_TIMEOUT_MS}ms for cwd=${cwd} — dropping knowledge section`
      )
      resolve(knowledgeFilesFrom([]))
    }, KNOWLEDGE_SCAN_TIMEOUT_MS)
  })

  try {
    return await Promise.race([scan, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

export function buildSpecFile(a: {
  title: string
  spec: string
  taskId: string
  dispatchId: string
  /** True when this dispatch runs in its own worktree, not the project folder (startWorker derives
   *  it from `!isSamePath(cwd, a.runCwd)` at its call site below — see the comment there for
   *  why the derivation lives at that one call site and not here too). **Not** `a.worktree !==
   *  'current'` — that was the original formula, and it is wrong for a --terminal reuse: the
   *  --terminal branch sets cwd to a.terminalCwd regardless of what a.worktree says (server.ts's
   *  default fills a.worktree with 'current' on that path), so a worktree session reused through
   *  --terminal read as committing:false and shipped its work with no commit obligation at all —
   *  a real defect this branch hit and fixed, not a hypothetical one. A worktree is merge material;
   *  an uncommitted change in it is invisible to the merge and is thrown away with the worktree. The
   *  commit has to be the coding agent's own act — a coding agent can end a turn without
   *  committing, and the app committing on
   *  its behalf would be committing content it never reviewed. Requiring it through the spec is the
   *  same shape as the reporting obligation below: the app assembles the instruction, the worker
   *  cannot edit it out. */
  committing?: boolean
  /** 이 프로젝트가 자기 결정을 적어 둔 파일들(core/knowledge/detect.ts 의 knowledgeFilesFrom).
   *  없거나 비면 이 절이 아예 붙지 않는다 — 지식이 없는 저장소에서 spec 이 달라지지 않아야 한다.
   *
   *  **경로는 상대 경로여야 한다.** 워커는 워크트리에서 돌고 그 cwd 는 프로젝트 폴더가 아니다.
   *  절대 경로를 받으면 워커가 자기 트리 밖의 문서를 읽어, 자기가 고칠 코드와 다른 트리의 결정을
   *  본다 — 조용히 어긋나고 결과물에만 나타난다. 상대 경로로 만드는 일은 부르는 쪽(startWorker)이
   *  한다. */
  knowledge?: KnowledgeFiles
}): string {
  // 커밋·보고 의무보다 앞에 둔다 — 그 둘은 일이 끝난 뒤의 의무이고 이것은 시작하기 전에 읽을
  // 것이다. spec 본문 뒤인 이유: 무엇을 하는 일인지 읽은 다음에야 "그 결정이 어디 있는지"가
  // 쓸모를 갖는다.
  // 본문을 싣지 않고 경로만 싣는다 — 파일은 저장소에 이미 있고 에이전트에게는 파일 도구가 있다.
  // 본문을 박으면 spec 이 커지고 그 파일이 바뀌는 순간 낡는다.
  const knowledgeSection =
    a.knowledge && a.knowledge.paths.length > 0
      ? `
---
## Project knowledge (assembled by the app — do not delete)

This repository records its own decisions and architecture notes in the files below. Read the ones
that touch your task **before** you change anything: they say which alternatives were already
rejected and why, and reopening a closed decision is work that gets thrown away.

Paths are relative to the directory you are working in.

${a.knowledge.paths.map((p) => `  ${p}`).join('\n')}
${a.knowledge.more > 0 ? `\n  … and ${a.knowledge.more} more file(s) in the project's knowledge directories.\n` : ''}`
      : ''

  // Inserted before the reporting obligation, not after — a worker that reports first and commits
  // second can still end its turn (the spec never told it not to) between the two, leaving the
  // report and the commit racing each other for no reason. Requiring the commit first removes that
  // race instead of relying on the agent to read ahead.
  const commitObligation = a.committing
    ? `
---
## Commit obligation (assembled by the app — do not delete)

This task is running in its own worktree, on its own branch — not in the project folder. When the
work is finished you must commit it: that is the only way the app can bring this work back together
with the results of the other tasks running in parallel. Right now this work exists only on this
worktree's branch; if you do not commit it, it never merges anywhere and it is discarded once this
worktree is torn down.

  git add -A
  git commit -m "<one-line summary of the change>"

Commit before you report below.
`
    : ''

  return `# ${a.title}

${a.spec}
${knowledgeSection}${commitObligation}
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
  /** 이 프로젝트가 자기 결정을 적어 둔 파일들. 구현자의 spec 과 **같은 목록**을 받는다
   *  (knowledgeIn). 검토자에게 이것을 주는 이유: 이 기능이 있는 목적이 에이전트가 닫힌 결정을 다시
   *  열지 않게 하는 것이고, **다시 열렸는지 잡는 것이 검토자의 일**이다. 목록을 안 주면 그 자리가
   *  빈다. 없거나 비면 이 절이 붙지 않는다. */
  knowledge?: KnowledgeFiles
}): string {
  // 구현자용 문구를 그대로 쓰지 않는다. 구현자는 "고치기 전에 읽어라"를 받고, 검토자는 "다시 열린
  // 결정은 구체적 결함이다"를 받아야 한다 — 같은 글을 두 번 실으면 이 자리가 값을 못 낸다.
  // **좁혀 둔 판정 기준을 넓히지 않는다.** 아래 "The one question you answer" 가 취향으로 반려하는
  // 것을 일부러 막아 두었으므로, 이 절도 "결정을 다시 연 것"만 결함이라 말하고 그 결정 자체와
  // 다투는 것은 범위 밖이라고 못박는다.
  const knowledgeSection =
    a.knowledge && a.knowledge.paths.length > 0
      ? `
## The project's own decisions (assembled by the app — do not delete)

This repository records its decisions and architecture notes in the files below. The implementer was
handed the same list. They bind this work the way the requirement above does.

Read the ones this change touches. **A decision that was reopened is a concrete finding, not a matter
of taste** — if the work takes a path one of these files rejected, name the file and what it settled.
That is the same kind of ground as a change contradicting the spec.

What is **not** ground for rejection is disagreeing with a decision yourself. These are the project's
settled positions; re-litigating one is outside this review.

${a.knowledge.paths.map((p) => `  ${p}`).join('\n')}
${a.knowledge.more > 0 ? `\n  … and ${a.knowledge.more} more file(s) in the project's knowledge directories.\n` : ''}`
      : ''

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

${knowledgeSection}
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
    /** The finished spec file, when the caller assembled it itself. `spec` above is a **body** —
     *  buildSpecFile wraps it in the implementer's template (an H1, then the reporting obligation with
     *  --files-modified and the escalation boilerplate). A review dispatch needs a different file, not
     *  a different body: buildReviewSpecFile already carries its own H1 and its own obligation, and
     *  wrapping it would append "give the paths through --files-modified" underneath a file whose
     *  first instruction is "do not change any code" — two contradicting instruction sets in one
     *  file. So the caller hands the whole file over and this skips the builder. Not named specFile:
     *  specPath in the return value already means a location and the two must not read alike. */
    specFileContent?: string
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
      // would defeat SessionManager.spawn's CWD_MISSING guard (core/sessions/manager.ts) and let a
      // worker boot in an empty directory that is not a repository.
      const stat = await fs.stat(a.worktree).catch(() => null)
      if (!stat || !stat.isDirectory())
        throw new Error(`worktree path does not exist: ${a.worktree}`)
      cwd = a.worktree
    }

    // specPath has nothing to do with cwd (it was settled above) — the wiring creates this directory
    // at boot, but the user can delete it in the meantime, so the mkdir stays.
    await fs.mkdir(path.dirname(specPath), { recursive: true })
    // committing asks one question — "does this worker run somewhere other than the project
    // folder" — and cwd is the only place that question has a single, already-settled answer.
    // a.worktree looks like the same fact but is not: it is only one of the four inputs that decide
    // cwd above, and the --terminal branch ignores it outright (cwd becomes a.terminalCwd no matter
    // what a.worktree says). Deriving from a.worktree would silently disagree with reality for a
    // --terminal reuse of a worktree session, which is exactly the "call reused, --worktree not
    // repeated" shape server.ts's default (worktree='current') makes the common case, not a rare
    // one. cwd !== a.runCwd covers all four branches with one comparison: 'current' sets cwd =
    // a.runCwd (false), 'new' and an explicit path set cwd to somewhere else (true unless the
    // explicit path happens to equal runCwd, which is correctly false — it is the project folder
    // either way), and --terminal carries whatever the original dispatch actually used.
    //
    // isSamePath (not ===) because a.runCwd and a.terminalCwd are recorded independently (Run.cwd
    // vs a Dispatch's cwd field) and can name the same folder with different casing or separators
    // (a Windows drive letter typed/stored as `d:` vs `D:`, or `\` vs `/`) without being different
    // folders. isSamePath already carries this exact win32-first normalization for the same "same
    // folder" question elsewhere (view.ts's project ownership check, ipc.ts's home-path check), so
    // it is reused here rather than inventing a fresh comparison. This repository is win32-first
    // (isPathWithin/isSamePath's own comment), so that normalization is the established answer, not
    // a new judgment call being made here.
    await fs.writeFile(
      specPath,
      // The caller may have assembled the file already (a review dispatch does — see
      // specFileContent). Only when it did not does the implementer's template get built here.
      a.specFileContent ??
        buildSpecFile({
          title: a.title,
          spec: a.spec,
          taskId: a.taskId,
          dispatchId: a.dispatchId,
          committing: !isSamePath(cwd, a.runCwd),
          knowledge: await knowledgeIn(cwd, this.deps.log)
        }),
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
