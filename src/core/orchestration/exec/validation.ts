// 검증 배선 — 앱(src/main/ipc.ts 의 bootOrch)과 Host 가 **같은 것을** 짓는다(설계 §5.1, R12).
//
// TaskValidator(validator.ts)에 러너와 두 콜백을 달고, 서버의 OrchServerDeps.startValidation 본문(큐에
// 넣고, 그 옆에서 완료 정책 지문과 의심 파일을 계산한다)을 함께 돌려준다. 이 본문들은 예전에
// ipc.ts 안에 인라인으로 있었고 그 자리에는 유닛 테스트가 닿지 않아, 속성 5 를 글자 가드
// (ipcConvergenceWiring.test.ts)로 지켰다 — 이제 validation.test.ts 가 동작으로 지킨다(R28).
//
// **electron·src/main·src/renderer 를 import 하지 않는다.** 두 프로세스가 서로 다른 것은 전부
// ValidationContext 로 주입받는다: 경로 가드(앱의 assertAllowedPath, Host 의 hostPathGuard), 저장된
// 실행 구성(앱의 RunConfigStore, Host 의 run-configs.json), 실행 관리자, 세션 생존 여부, 검토·수리의
// 시작, continuity journal 의 첫 체크포인트 head(Host 에서는 언제나 null, R12), git diff.
import { t, type Lang, type MessageKey } from '../../i18n'
import type { RunConfig } from '../../run/config'
import { seedKeyOf } from '../../run/config'
import { loadRunConfigs, prepareRun } from '../../run/prepare'
import type { StartOpts } from '../../run/runManager'
import { checkConfigIdsOf, completionPolicyHash, policyOf, suspiciousCheckFiles } from '../convergence'
import {
  applyValidationResult,
  blockForValidation,
  jobOf,
  stampPolicySnapshot,
  type OrchState
} from '../state'
import type { Dispatch } from '../types'
import { repairTargetFor } from './repair'
import { TaskValidator } from './validator'

export interface ValidationContext {
  getState(): OrchState
  setState(next: OrchState): Promise<void>
  now(): string
  lang(): Lang
  log(m: string): void
  /** The path guard (the app's assertAllowedPath; the Host's hostPathGuard). A refusal is a Gate. */
  assertAllowedPath(p: string): Promise<string>
  /** The saved configurations of one project (the app's RunConfigStore; the Host's run-configs.json). */
  storedConfigs(projectPath: string): RunConfig[] | Promise<RunConfig[]>
  runs: {
    start(o: StartOpts): { runId: string }
    recentOutput(runId: string): string
    stop(runId: string): void
  }
  isAlive(sessionId: string): boolean
  /** Fire and forget; the module attaches the terminal catch. */
  startReview(a: { taskId: string }): Promise<void>
  startRepair(a: { dispatchId: string }): Promise<unknown>
  /** The journal's first checkpoint head for a Dispatch, or null (always null in the Host, R12). */
  firstCheckpointHead(dispatchId: string): string | null
  /** `git diff` for the suspicious-file calculation. */
  diffNames(cwd: string, fromHead: string): Promise<string[] | null>
}
export interface TaskValidation {
  validator: TaskValidator
  /** OrchServerDeps.startValidation's body: enqueue, then the policy stamp and the suspicious files beside it. */
  startValidation(a: { taskId: string; cwd: string }): void
}

export function createTaskValidation(c: ValidationContext): TaskValidation {
  // 검증 실행. runner 는 prepareRun + RunManager 이고, 결과는 서버의 setState 로 되돌아간다.
  // dispatchOf 로 cwd 에서 Task 를 되찾지 않는 이유: TaskValidator 가 taskId 를 들고 있다.
  const validator = new TaskValidator({
    runner: {
      start: async ({ cwd, taskId, configId }) => {
        const st = c.getState()
        const task = st.tasks.find((t) => t.id === taskId)
        if (!task) throw new Error(`unknown task ${taskId}`)
        // 큐에서 기다리는 동안 Task 가 validating 을 떠났을 수 있다(task-update). 그대로 두면
        // 빌드 전체가 돌고 실행 패널을 차지한 뒤에야 applyValidationResult 가
        // 결과를 거절한다. 던지지 않고 'skip' 을 돌려주는 이유는 ValidatorRunner.start 의 주석에
        // 있다 — 이것은 실패가 아니라 없어진 할 일이다.
        if (task.status !== 'validating') return 'skip'
        const run = st.runs.find((r) => r.id === task.runId)
        if (!run) throw new Error(`unknown run for task ${taskId}`)
        // PTY 를 띄울 경로는 가드를 통과해야 한다. Dispatch.cwd 는 오케스트레이션 소켓에서 온
        // 값이고 resolveProjectRoot 는 ADR-003 이 명시하듯 "최선 노력이지 검증이 아니다".
        // 실패하면 그것이 그대로 Gate 가 되므로(onCannotRun) 여기가 올바른 자리다.
        await c.assertAllowedPath(cwd)
        // 구성은 Run 의 프로젝트에서, 실행은 Dispatch 의 cwd 에서. ignoreConfigCwd 는 구성에 박힌
        // 경로가 워커의 트리가 아닌 곳을 가리키기 때문이다(spec 2절). configId 는 TaskValidator 가
        // enqueue 의 configIds 목록에서 지금 도는 자리를 골라 넘긴 것이다.
        const runJobCwd = jobOf(st, run)?.cwd ?? ''
        const { config, command, projectName } = await prepareRun({
          projectPath: runJobCwd,
          configId,
          stored: await c.storedConfigs(runJobCwd),
          ignoreConfigCwd: true,
          assertAllowedPath: (p) => c.assertAllowedPath(p),
          t: (key, params) => t(c.lang(), key as MessageKey, params)
        })
        // validation: marks this run as not the user's. The run list and the global badge label it,
        // and run.stop routes markStopped by it (RunStatus.validation). Nothing waits for the user's
        // own runs any more — a validation starts beside them; same-tree validations are serialised
        // by TaskValidator's own queue.
        const started = c.runs.start({ projectPath: cwd, projectName, config, command, validation: true })
        return { runId: started.runId, name: config.name }
      },
      output: (runId) => c.runs.recentOutput(runId).slice(-4000),
      // 타임아웃이 이 PTY 를 두 번째로 멈춘다(validator.ts 의 startCheck 타이머). **c.runs.stop 을
      // 직접 부른다 — 앱의 `ipcMain.handle('run.stop', ...)` 을 거치지 않는다.** 그 핸들러는 사용자가
      // 화면에서 직접 멈춘 검증 실행에 `orchValidator.markStopped` 까지 얹어 "실패가 아니라 증명
      // 못 함"으로 읽는다(그 핸들러의 주석). 이 stop 은 이미 validator.ts 자신이 head.timedOut 으로
      // 표시해 두었으므로, 여기서 markStopped 까지 걸면 한 exit 에 stopped 와 timedOut 이 겹치고
      // onRunExit 은 stopped 를 먼저 보므로(그 순서의 주석) 이 exit 가 "사용자가 정지했다"로 읽혀
      // timeout 의 재시도·기록이 사라진다. c.runs.stop 을 바로 부르면 PTY 만 죽고 그 겹침이 없다.
      //
      // **던지지 않는다 — 이 자리는 바로 setTimeout 콜백이다(validator.ts).** 여기서 던지면 잡을
      // 것이 없는 uncaught exception 으로 main 프로세스가 죽는다(리뷰 fix 1차, Minor). status 확인
      // (RunManager.stop 은 status !== 'running' 이면 no-op)이 있어도, POSIX 에서는 그 확인과 실제
      // pty.kill() 사이에 그 프로세스가 스스로 막 끝나는 창이 있을 수 있다 — node-pty 는 죽은 pid 에
      // kill 을 던질 수 있고, write/resize 를 감싸는 withExitedPtyGuard 는 stop 을 감싸지 않는다.
      // 잡아서 로그만 남긴다: 그 경우 프로세스는 이미 스스로 끝났으므로 pty 의 자연스러운 exit 가
      // 뒤따라 오고, head.timedOut 은 그대로 남아 있어 그 exit 를 여전히 timeout 으로 정산한다.
      stop: (runId) => {
        try {
          c.runs.stop(runId)
        } catch (e) {
          c.log(`validator: run.stop failed for run=${runId}: ${String(e)}`)
        }
      }
    },
    onSettled: async ({ taskId, results }) => {
      const before = c.getState()
      // 판정 직전에 repair 대상을 정한다(설계 §6.2) — 순수 층(state.ts)은 세션이 살아 있는지 모른다.
      // 서버가 검토 판정에서 하는 것과 같은 판정이다(ipc.ts 의 deps.repairTargetFor).
      const repair = repairTargetFor(before, taskId, (id) => c.isAlive(id))
      const r = applyValidationResult(
        before,
        // 서버가 applyWorkerDone 에 넘기는 것과 같은 값들이다 — 이 배선에는 startReview 가 있다.
        // repair 는 convergence Run 에서 필수다(없으면 순수 층이 거절한다); lang 은 Gate 문구의
        // 언어다.
        { taskId, results, canReview: true, ...(repair ? { repair } : {}), lang: c.lang() },
        c.now()
      )
      if (!r.ok) {
        c.log(`validation result rejected task=${taskId}: ${r.error}`)
        return
      }
      await c.setState(r.state)
      // 검증이 통과했고 검토가 걸려 있으면 여기서 이어진다. 서버의 worker_done 분기가 검증이 걸리지
      // 않은 Task 에 대해 같은 일을 한다. cwd 는 넘기지 않는다 — startReview 가 구현 Dispatch 에서
      // 얻는다(그 Dispatch 를 provider 때문에 어차피 찾는다).
      // 종단 .catch 를 붙인다 — 이유는 ipc.ts 의 deps.startReview 쪽 주석에 있다(validator 가 자기
      // onSettled/onCannotRun 에 붙이는 것과 같은 것이다).
      if (r.value.status === 'reviewing')
        void c.startReview({ taskId }).catch((e) =>
          c.log(`startReview failed task=${taskId}: ${String(e)}`)
        )
      // 판정이 repair Dispatch 를 새로 열었으면(routeFailure) 그 부수 효과(spec 파일을 쓰고 살아
      // 있는 세션에 넣거나 새 워커를 띄운다)를 시작한다 — **커밋(위 setState) 뒤에만** 부른다.
      // **여기서도 getState() 를 다시 읽는다** — r.state 를 그대로 뒤지지 않는다. 서버의 검토
      // 판정 분기(server.ts)가 자신의 setState 뒤에 afterReview = deps.getState() 로 다시 읽는
      // 것과 같은 모양이다 — 지금은 둘이 갈라질 수 없지만(그 사이에 await 가 없다), 한쪽이 나중에
      // await 를 얻어도 이 자리가 조용히 낡은 채로 남지 않는다. openRepairDispatch 가 채우는
      // specPath 는 '' 이므로 !d.specPath 는 그것도 "아직 시작되지 않았다"로 읽는다(performRepair
      // 의 liveRepairDispatch 와 같은 조건).
      const afterValidation = c.getState()
      const opened = afterValidation.dispatches.find(
        (d) => d.taskId === taskId && d.repair !== undefined && !d.endedAt && !d.specPath
      )
      if (opened)
        void c.startRepair({ dispatchId: opened.id }).catch((e) =>
          c.log(`repair failed task=${taskId}: ${String(e)}`)
        )
    },
    onCannotRun: async ({ taskId, reason }) => {
      const r = blockForValidation(c.getState(), { taskId, reason }, c.now())
      if (!r.ok) {
        c.log(`could not block task=${taskId}: ${r.error}`)
        return
      }
      await c.setState(r.state)
    },
    log: (m) => c.log(m)
  })

  /** 이 Task 의 **첫** 구현 Dispatch(검토가 아닌 것 중 가장 먼저 시작한 것) — convergence.ts 의
   *  latestImplDispatch 의 반대쪽 끝이다. changedFilesSince(아래)의 기준점은 이 Dispatch 여야
   *  한다: 이 Task 가 일을 시작한 지점부터의 diff 가 목적이고, 마지막(수리를 포함한) 시도만의
   *  diff 가 아니다(리뷰 fix 1차, Important 2b). */
  const firstImplDispatch = (s: OrchState, taskId: string): Dispatch | undefined =>
    s.dispatches
      .filter((d) => d.taskId === taskId && !d.review)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .at(0)

  /** startValidation(아래)이 검증을 큐에 넣기 전에 부르는 최선노력 계산(설계 §8.3) — 이 시도가
   *  check 의 동작을 바꾸는 파일을 건드렸는지. **기준점은 continuity journal 의, 이 Task 의 첫
   *  구현 Dispatch 에 대한 첫 체크포인트 head 뿐이다**(c.firstCheckpointHead).
   *
   *  **`Dispatch.stopSnapshot.headCommit` 을 쓰지 않는다(리뷰 fix 1차, Important 2a).** 그것은
   *  그 Dispatch 의 **마지막** 사용량 한도 정지 시점의 HEAD 이고 정지마다 덮어써서, 이미 일부
   *  작업이 반영된 뒤의(기준점보다 나중인) 값이다 — 그것을 기준으로 잡으면 diff 가 실제보다
   *  좁아져, 계정을 갈아타며 일한 바로 그 경우에 의심 파일을 놓친다. `firstCheckpointFor` 가
   *  주는 'attempt-started' 체크포인트(core/continuity/checkpointPolicy.ts 의 KIND_OF — Dispatch
   *  가 열릴 때 기록된다)가 그 Dispatch 가 일을 시작하기 **전**의 HEAD 다.
   *
   *  기준점이 없으면(continuity 가 꺼져 있거나 체크포인트가 없다, Host 에서는 언제나 — R12) git 을
   *  부르지 않고 Task 가 이미 보고한 filesModified 로 물러난다 — 이 계산의 실패가 검증 자체를 막아서는
   *  안 되므로(호출부의 주석), git 이 실패해도(c.diffNames 가 null) 같은 자리로 물러난다.
   *
   *  **Task 의 filesModified 를 쓴다, Dispatch 의 것이 아니다** — Dispatch 에는 그런 칸이 없다. */
  const changedFilesSince = async (first: Dispatch, cwd: string): Promise<string[]> => {
    const head = c.firstCheckpointHead(first.id)
    if (head) {
      const names = await c.diffNames(cwd, head)
      if (names) return names
    }
    return c.getState().tasks.find((t) => t.id === first.taskId)?.filesModified ?? []
  }

  // checkConfigIdsOf 는 옛 validateConfigId 와 새 validateConfigIds 를 함께 읽으므로, 지금
  // 존재할 수 있는 모든 Task 에 대해 이것으로 충분하다.
  const startValidation = ({ taskId, cwd }: { taskId: string; cwd: string }): void => {
    const task = c.getState().tasks.find((t) => t.id === taskId)
    validator.enqueue({ taskId, cwd, configIds: task ? checkConfigIdsOf(task) : [] })
    // 의심 파일(설계 §8.3) — **convergence Run 에서만** 계산한다(리뷰 fix 1차, Important 1).
    // 이 계산은 Task 에 suspiciousFiles 를 써서 리뷰어 spec 에 새 절을 만드는데, 다른 모든
    // convergence 전용 자리(state.ts 의 checks 기록, server.ts 의 readReviewFile 가드)가
    // "convergence 가 없으면 오늘과 바이트 단위로 같다"를 지키므로 여기도 그래야 한다.
    // policyOf 로 판정한다 — run.convergence !== undefined 가 아니라: 손으로 고친
    // "convergence": null 을 정책 있음으로 잘못 읽지 않는다(Task 11 의 같은 판단).
    // 검증을 늦추지 않도록 큐에 넣은 뒤 옆에서 계산한다. 구현 Dispatch 가 없거나 의심 파일이
    // 없으면 아무것도 쓰지 않는다(빈 배열을 Task 에 남기지 않는다). 실패해도 검증 자체는 이미
    // 큐에 들어가 그대로 돈다 — 그래서 종단 .catch 는 로그만 남긴다.
    const pol = task ? policyOf(c.getState(), task) : null
    if (!task || pol === null) return
    // 설계 G3(명세 §37·§36): 이 라운드가 쓰는 완료 정책의 지문을 찍는다. 처음이면 스냅숏이 되고,
    // 이미 있는데 달라졌으면 `policyChanged` 가 선다 — 막지 않고 표시한다.
    //
    // 구성 조회가 비동기라(loadRunConfigs) 의심 파일과 같은 자리에서, 검증을 늦추지 않도록 큐에
    // 넣은 뒤 옆에서 한다. 실패해도 검증은 그대로 돈다 — 지문이 없으면 다음 라운드에 다시 찍는다.
    void (async () => {
      const { configs } = await loadRunConfigs({
        projectPath: cwd,
        stored: await c.storedConfigs(cwd),
        assertAllowedPath: (p) => c.assertAllowedPath(p)
      })
      const byId = new Map(configs.map((cfg) => [cfg.id, cfg]))
      const key = completionPolicyHash(task, pol, (id) => {
        const cfg = byId.get(id)
        return cfg ? seedKeyOf(cfg) : null
      })
      await c.setState(stampPolicySnapshot(c.getState(), { taskId, key }, c.now()))
    })().catch((e) => c.log(`policy snapshot task=${taskId}: ${String(e)}`))
    void (async () => {
      const first = firstImplDispatch(c.getState(), taskId)
      if (!first) return
      const suspicious = suspiciousCheckFiles(await changedFilesSince(first, cwd))
      if (suspicious.length === 0) return
      const st = c.getState()
      await c.setState({
        ...st,
        tasks: st.tasks.map((t) => (t.id === taskId ? { ...t, suspiciousFiles: suspicious } : t))
      })
    })().catch((e) => c.log(`suspicious files task=${taskId}: ${String(e)}`))
  }

  return { validator, startValidation }
}
