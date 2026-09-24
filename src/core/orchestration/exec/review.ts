// 검토 시작 — 앱(src/main/ipc.ts 의 bootOrch)과 Host 가 **같은 것을** 짓는다(설계 §5.1).
//
// 서버의 OrchServerDeps.startReview 가 흘려보내는 본문(검토자를 고르고, 검토 Dispatch 를 커밋하고,
// 검토 spec 을 조립해 세션을 띄운 뒤 그 Dispatch 를 메운다)과, 그것이 실패를 넘기는 reviewGate 를 한
// 자리에 둔다. 이 본문은 예전에 ipc.ts 안에 인라인으로 있었고 그 자리에는 유닛 테스트가 닿지 않아,
// Finding 1(resultPath 는 convergence Run 에서만)과 ruling F63(세워 둔 회차에는 검토 Dispatch 를 열기
// **전에** 거절한다)을 글자 가드(ipcConvergenceWiring.test.ts)로 지켰다 — 이제 review.test.ts 가 동작으로
// 지킨다(R28). ipc.ts 에서 옮긴 본문은 줄 단위로 같다: 상태를 읽는 자리, await 의 순서, 늦은 바인딩이
// 그대로다.
//
// **electron·src/main·src/renderer 를 import 하지 않는다.** 두 프로세스가 서로 다른 것은 전부
// ReviewContext 로 주입받는다: 상태의 문, 계정 목록과 로그인 조회, 경로 가드, spec 디렉터리, 그리고
// 체인과 tail 을 붙이는 startWorker 래퍼.
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Account } from '../../types'
import type { OrchServerDeps } from '../command'
import { checkConfigIdsOf, policyOf } from '../convergence'
import { pickReviewer } from '../reviewer'
import { openReviewDispatch, type OrchState } from '../state'
import { buildReviewSpecFile, knowledgeIn, specFileName } from './coordinator'
import { createReviewGate } from './reviewGate'

export interface ReviewContext {
  getState(): OrchState
  setState(next: OrchState): Promise<void>
  now(): string
  log(m: string): void
  accounts(): Account[] | Promise<Account[]>
  loginStatus(accountId: string): Promise<boolean>
  assertAllowedPath(p: string): Promise<string>
  /** The start wrapper that attaches the chain and the tail — never the bare coordinator. */
  startWorker: OrchServerDeps['startWorker']
  specsDir: string
}

/** OrchServerDeps.startReview 의 본문을 돌려준다. 돌려준 함수는 흘려보내는 쪽이 종단 .catch 를
 *  붙인다(ipc.ts 의 deps.startReview, validation.ts 의 onSettled). */
export function createReviewStarter(c: ReviewContext): (a: { taskId: string }) => Promise<void> {
  /** 검토를 시작하지 못했을 때 Task 를 사람에게 넘기는 자리, 그리고 그중 넘기지 **않는** 하나의
   *  거절(ruling F37). 둘 다 reviewGate.ts 에 있다 — 여기의 화살표 함수는 부를 때 c 를 읽으므로,
   *  앱이 c 의 자리에 아직 정의되지 않은 deps 를 넘겨도 순서 문제는 없다(orchTails·repairDeps 와 같은 모양). */
  const reviewGate = createReviewGate({
    getState: () => c.getState(),
    setState: (next) => c.setState(next),
    now: () => c.now(),
    log: (m) => c.log(m)
  })

  /** 검토 세션 하나를 띄운다. 실패하는 모든 경로가 Gate 로 간다 — 조용히 통과시키면 "검토됨"과
   *  "검토 못 함"이 화면에서 같아진다. **한 갈래만 예외이고 그것은 실패가 아니다**: 이미 검토가
   *  돌고 있다는 거절(reviewGate.onOpenRefused). */
  const startReview = async ({ taskId }: { taskId: string }): Promise<void> => {
    /** Gate 로 넘긴다. 규칙과 그 이유는 `createReviewGate` 에 있다(core/orchestration/exec/reviewGate.ts)
     *  — 이 자리에 있던 것을 그대로 옮겼고, 옮긴 이유는 그 파일의 머리말에 있다. */
    const gate = (reason: string): Promise<void> => reviewGate.gate({ taskId, reason })
    try {
      const st = c.getState()
      const task = st.tasks.find((t) => t.id === taskId)
      // 큐를 거치지 않고 곧바로 오지만, setState 뒤에 불리므로 그 사이 task-update 가 상태를
      // 옮겼을 수 있다. validator.start 가 같은 이유로 'skip' 을 돌려준다.
      if (task?.status !== 'reviewing') return
      // **세워 둔 회차에는 검토자를 띄우지 않는다**(ruling F63). 판정과 거절을 함께 reviewGate 가
      // 들고 있다 — 그 이유는 그 파일에 있고, 요점은 그것이 상태를 놓고 검사할 수 있는 판정이라는
      // 것이다. **이 자리가 큐로 들어온 보고의 뒷문이기도 하다**: 대기 보고 배수가 worker_done 을
      // 적용하면 applyWorkerDone 이 수렴 Run 의 Task 를 곧바로 reviewing 으로 보내고 여기를 부른다.
      if (await reviewGate.refuseIfRunGated({ taskId })) return
      // 구현 Dispatch — 그 provider 를 피해야 하고, cwd 도 여기서 얻는다(그래서 이 함수는 taskId
      // 하나만 받는다: 호출자가 cwd 를 따로 구하면 두 경로가 갈라진다)
      const impl = st.dispatches
        .filter((d) => d.taskId === taskId && !d.review)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .at(-1)
      if (!impl) return void (await gate(`no implementation dispatch for task ${taskId}`))
      const cwd = impl.cwd
      const accounts = await c.accounts()
      // core.ts 의 defaultAccountIdFor 와 같은 모양 — 로그인 조회는 계정마다 파일(또는 macOS 에서는
      // Keychain)을 읽으므로 순차로 돌리면 계정 수만큼 늘어난다. 같은 일을 하는 자리가 이미 있으니
      // 그 모양을 따른다.
      const loggedInIds = await Promise.all(
        accounts.map(async (a) => ((await c.loginStatus(a.id)) ? a.id : null))
      )
      const loggedIn = new Set(loggedInIds.filter((id): id is string => id !== null))
      const picked = pickReviewer({ implProvider: impl.provider, accounts, loggedInIds: loggedIn })
      if (!picked)
        return void (await gate(`no logged-in account on a provider other than ${impl.provider}`))
      // PTY 를 띄울 경로는 가드를 통과해야 한다 — validator.start 와 같은 이유(Dispatch.cwd 는
      // 오케스트레이션 소켓에서 온 값이고 정규화는 검증이 아니다, ADR-003).
      await c.assertAllowedPath(cwd)
      // Dispatch 를 먼저 커밋한다 — 세션을 띄우기 전에 id 가 있어야 spec 파일의 보고 문장에
      // 그것을 실을 수 있다. worker-start 가 같은 순서다(server.ts: openDispatch 커밋 → startWorker).
      //
      // **입구의 st 가 아니라 여기서 다시 읽은 상태를 넘긴다.** 위의 loginStatus 와
      // assertAllowedPath 는 진짜 await(계정마다 파일·Keychain 읽기, knownProjectPaths)이고, 그
      // 사이에 다른 흐름이 커밋할 수 있다. st 를 넘기면 setState 가 그 낡은 상태를 통째로 되쓰므로
      // 그 창에 들어온 커밋이 디스크에서만이 아니라 메모리에서도 사라진다 — 남의 Task 의
      // worker_done 이 되돌려져 그 Dispatch 가 다시 열리고, 이미 "ok" 를 듣고 떠난 워커는 두 번
      // 보고하지 않는다. server.ts 가 probeLimit 뒤에 getState 를 다시 읽는 것과 같은 규칙이고,
      // store.ts 가 같은 것을 못박아 두었다. worker-start 는 openDispatch 앞의 검사가 전부 동기라서
      // 입구 스냅숏을 그대로 넘길 수 있다 — 이쪽은 그렇지 않다.
      //
      // 그 창에서 옮겨졌을 상태도 여기서 다시 본다. 입구의 검사는 이제 너무 이르다 — 그것은
      // 로그인 조회를 아끼는 값싼 선검사로 남는다.
      const fresh = c.getState()
      const freshTask = fresh.tasks.find((t) => t.id === taskId)
      if (freshTask?.status !== 'reviewing') return
      const opened = openReviewDispatch(
        fresh,
        {
          taskId,
          provider: picked.provider,
          accountId: picked.accountId,
          // 세션 id 는 아직 없다. worker-start 가 같은 자리에서 쓰는 자리표시자와 같은 모양이다
          // (server.ts 의 handleCommand, worker-start 분기의 pendingSessionId: `pending:${randomBytes(4).toString('hex')}`) — 그 값은 어떤 세션도
          // 가리키지 않으며 jobTaskOf 의 isKnownSession 이 걸러 낸다.
          sessionId: `pending:${randomBytes(4).toString('hex')}`,
          cwd,
          specPath: ''
        },
        c.now()
      )
      // **모든 거절이 Gate 로 가지는 않는다** — `dispatch already open` 은 실패가 아니라 남이 먼저
      // 시작했다는 뜻이고, 그것을 Gate 로 보내면 돌고 있는 검토가 무너진다(ruling F37). 판정은
      // `onOpenRefused` 안에 있다.
      if (!opened.ok) return void (await reviewGate.onOpenRefused({ taskId, error: opened.error }))
      await c.setState(opened.state)
      const spec = buildReviewSpecFile({
        title: task.title,
        spec: task.spec,
        taskId,
        dispatchId: opened.value.id,
        implReport: task.result,
        filesModified: task.filesModified,
        // checkConfigIdsOf 는 옛 validateConfigId 와 새 validateConfigIds 를 함께 읽는다 — 이 칸만
        // 보면 새 필드만 쓰는 Task 는 "검증 없음"으로 잘못 읽힌다.
        validated: checkConfigIdsOf(task).length > 0,
        // 구현자와 **같은 목록**을 받는다 — 검토자의 일이 "닫힌 결정이 다시 열렸는지"를 잡는 것인데
        // 그 목록을 안 주면 그 자리가 빈다. 훑는 뿌리도 같다: 검토자는 구현자가 일한 트리에서
        // 돈다(바로 아래 worktree 'current' + runCwd = 그 cwd).
        knowledge: await knowledgeIn(cwd, c.log),
        // 이 Task 가 이미 들고 있는 값을 그대로 옮긴다(설계 §8.1·§8.3) — checks 는 마지막 검증
        // 라운드의 check 별 결과, previousIssues 는 직전 검토 라운드의 이슈(buildReviewSpecFile
        // 이 그중 blocking 만 추린다), suspiciousFiles 는 startValidation 이 검증을 큐에 넣을 때
        // best-effort 로 채워 둔 것이다.
        //
        // **suspiciousFiles 만 freshTask 에서 읽는다, task 가 아니다(리뷰 fix 1차, Minor).**
        // startValidation 의 그 계산은 이 흐름과 동시에 도는 별개의 비동기 흐름이라, 맨 위의 st
        // 를 읽은 뒤 이 자리에 오기까지의 그 어떤 await(로그인 조회 등) 사이에도 끝나 커밋될 수
        // 있다 — checks·previousIssues 는 이 판정이 reviewing 으로 넘어오기 전에 이미 끝난
        // 값이라 그런 창이 없다.
        checks: task.checks,
        previousIssues: task.reviewIssues,
        suspiciousFiles: freshTask.suspiciousFiles,
        policyChanged: freshTask.policyChanged === true,
        // review.ts·state.ts 가 이미 기대하는 이름과 같은 규칙이다 — 이 Dispatch 의 spec 파일
        // 이름(coordinator.ts 의 specFileName, startWorker 가 실제로 쓰는 그 이름)에
        // `.review.json` 을 붙인 것. **리터럴을 다시 적지 않는다** — 여기서 조립하는 시점에는
        // 코디네이터가 아직 돌지 않아 진짜 specPath 를 모르므로 같은 함수로 미리 계산해야 하고,
        // 독립된 리터럴은 오늘은 우연히 같아도 한쪽만 바뀌는 날 조용히 갈라진다(검토자는 아무도
        // 읽지 않는 파일에 쓰고, server.ts 는 그 파일을 찾지 못한다 — malformed 도 "이슈 없음"도
        // 아니다).
        //
        // **convergence Run 에서만 넘긴다(전체 브랜치 리뷰, Important 1).** server.ts 는
        // policyOf(...) !== null 일 때만 이 파일을 읽는다(applyReviewResult) — 없는 Run 에도 항상
        // 넘기면 그 Run 의 검토자가 아무도 읽지 않는 파일에 쓰고, "구조화된 판정" 절이 "파싱 실패는
        // 사람에게 간다"는 거짓을 말하게 된다. **raw 필드가 아니라 policyOf 다** — 나머지 모든
        // 관문과 같은 판별식(reconciler.ts 의 주석, exec/validation.ts 의 startValidation 가드와 같은 이유).
        ...(policyOf(fresh, task) !== null
          ? { resultPath: path.join(c.specsDir, `${specFileName(taskId, opened.value.id)}.review.json`) }
          : {})
      })
      let started: { sessionId: string; cwd: string; specPath: string }
      try {
        // 검토자는 구현자가 일한 트리에서 돈다 — worktree 'current' + runCwd = 그 cwd.
        //
        // **coordinator.startWorker 가 아니라 c.startWorker(앱의 deps.startWorker)다.** 그쪽은 통과 함수가 아니다 —
        // 코디네이터를 부른 뒤 orchTails.start 로 그 세션의 출력을 이 Dispatch 에 묶는다. 직접
        // 부르면 검토 Dispatch 에는 tail 이 없고 worker-read 가 untracked 를 돌려준다: 검토자가
        // 멈췄거나 판정이 이해되지 않을 때 코디네이터가 볼 것이 사라진다. 그리고 그 차이는 검토
        // Dispatch 만 다르게 행동하는 자리가 되어 다음 사람을 속인다.
        started = await c.startWorker({
          dispatchId: opened.value.id,
          taskId,
          title: `Review: ${task.title}`,
          // spec 은 본문이고 coordinator 가 그것을 **구현자의** 템플릿으로 감싼다 — 검토 파일을
          // 그 자리에 넣으면 H1 과 보고 의무가 두 벌이 되고, 마지막 줄이 "바꾼 파일의 경로를
          // --files-modified 로 넘겨라"가 되어 맨 위의 "코드를 바꾸지 말라"와 정면으로 부딪힌다.
          // 그래서 조립이 끝난 파일은 specFileContent 로 넘긴다(coordinator.ts 에 이유가 있다).
          // spec 은 이 경로에서 쓰이지 않지만 인터페이스의 필수 필드이므로 Task 의 본문을 준다 —
          // 빈 문자열을 주면 이 값이 무엇인지 다음 사람이 읽을 수 없다.
          spec: task.spec,
          specFileContent: spec,
          provider: picked.provider,
          accountId: picked.accountId,
          runCwd: cwd,
          worktree: 'current'
        })
      } catch (e) {
        // 검토 Dispatch 의 롤백은 gate() 안에 있다 — 커밋 뒤에 던지는 경로가 이 자리 하나가 아니기
        // 때문이다(그 이유는 gate 의 주석에 있다).
        return void (await gate(
          `failed to start the reviewer: ${e instanceof Error ? e.message : String(e)}`
        ))
      }
      // 실제 세션 id 와 spec 경로로 Dispatch 를 메운다. **여기서도 최신 상태를 다시 읽는다** —
      // 코디네이터를 기다리는 동안 그 Dispatch 에 다른 변경이 내려앉았을 수 있고, 넘겨줄 것은
      // 이 세 필드뿐이다(worker-start 의 같은 주석 참고).
      const latest = c.getState()
      await c.setState({
        ...latest,
        dispatches: latest.dispatches.map((d) =>
          d.id === opened.value.id
            ? { ...d, sessionId: started.sessionId, cwd: started.cwd, specPath: started.specPath }
            : d
        )
      })
      c.log(
        `review started task=${taskId} provider=${picked.provider} dispatch=${opened.value.id}`
      )
    } catch (err) {
      await gate(String(err))
    }
  }

  return startReview
}
