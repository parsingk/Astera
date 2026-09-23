// The start path for orchestration workers and coordinators, shared by every process that spawns
// them. The app's registerIpc wiring was its only home until the Host began spawning sessions too:
// moving the bodies here is what keeps both spawners on the same chain rule, the same brief file and
// the same folder-trust preset, instead of two copies that drift. Each caller supplies what only it
// has (its state store, its account list, its session spawner, its log) through the context.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { OrchServerDeps } from '../command'
import type { OrchState } from '../state'
import type { Account, Provider } from '../../types'
import { descriptorOf, isAmbientDir, type ProviderDescriptor } from '../../providers/descriptor'
import { providerOf } from '../../providers/meta'
import { rollChainFor } from '../../accounts/dispatchAccount'
import { markCodexProjectTrusted } from '../../accounts/codexTrust'
import { claudeConfigFileFor, markClaudeProjectTrusted } from '../../accounts/claudeTrust'
import { coordinatorLaunchPrompt } from '../handover'
import type { OrchCoordinator } from './coordinator'
import type { WorkerTails } from './tail'
import { coordinatorBriefName } from './specFiles'

export type StartWorkerArgs = Parameters<OrchServerDeps['startWorker']>[0]
export type StartWorkerResult = Awaited<ReturnType<OrchServerDeps['startWorker']>>
export interface WorkerStartContext {
  getState(): OrchState
  accounts(): Promise<Account[]>
  loginStatus(accountId: string): Promise<boolean>
  coordinator: Pick<OrchCoordinator, 'startWorker'>
  tails: WorkerTails
  log(m: string): void
}

/** The body of the app's old `startWorker` wrapper, unchanged: the rolling chain from Task.accountIds
 *  (rollChainFor), the two cases that skip the login lookup, the degraded-chain log lines, then the
 *  coordinator, then the tail.
 *
 *  **이 워커의 롤링 체인을 여기서 정한다 — 워커를 띄우는 길이 전부 이 함수로 모이기
 *  때문이다.** 자동 배치 루프도 orchHandleCommand('worker-start') 를 부르고, CLI 의
 *  worker-start 도 같은 핸들러이며(server.ts 의 deps.startWorker), 검토 Dispatch 도 이 함수를
 *  지난다. 체인을 그중 한 곳에서 넘기면 나머지 경로는 갈아탈 곳 없는 워커를 띄운다.
 *
 *  **The rule itself is rollChainFor**, a pure function with its own tests. What this function adds
 *  is what a pure function cannot hold: it reads the Task, asks the login status, swallows that
 *  lookup's exception, and logs why the chain degraded. */
export async function startWorkerWithChain(
  ctx: WorkerStartContext,
  a: StartWorkerArgs
): Promise<StartWorkerResult> {
  let rollAccountIds = [a.accountId]
  const stateHere = ctx.getState()
  const task = stateHere.tasks.find((t) => t.id === a.taskId)
  // The account list is read once, and only when the Task names accounts: both the provider lookup
  // and rollChainFor below need it, and a Task without accounts needs neither.
  const accountList = task?.accountIds?.length ? await ctx.accounts() : []
  // Task 의 provider — **그 Task 의 첫 계정이 정한다**(Task.accountIds). 계정 목록 조회는
  // 메모리에서 끝나므로(비싼 것은 아래 loginStatus 다) 이 한 걸음에 비용이 없다. 첫 id 가
  // 목록에 없으면 undefined — 아래 조건이 그 경우를 "어긋났다고 말할 수 없다"로 다룬다.
  const taskProvider = task?.accountIds?.length
    ? (() => {
        const first = accountList.find((x) => x.id === task.accountIds![0])
        return first ? providerOf(first) : undefined
      })()
    : undefined
  // **두 경우에 로그인 조회를 하지 않는다.**
  // (1) 지정이 없을 때 — 답은 요청된 계정 하나로 확정이고(rollChainFor), 그 조회는 계정마다 파일
  //     읽기(macOS 의 claude 계정은 `security` 프로세스)를 붙인다. 워커를 띄우는 모든 자리가 이
  //     함수를 지나므로 그 값을 헛되이 물릴 이유가 없다(자동 배치 루프가 바퀴마다 한 번만
  //     조회하는 것과 같은 이유).
  // (2) **띄우는 provider 가 이 Task 의 provider 와 다를 때** — 검토 Dispatch 가 그 자리다.
  //     검토자는 구현자와 다른 provider 이므로 Task 의 계정은 rollChainFor 안에서 전부 걸러지고,
  //     남는 것은 조회 비용과 "쓸 수 있는 계정이 하나도 없다"는 어긋난 로그뿐이다 — 사실은 그
  //     계정들이 다른 provider 의 것일 뿐이고 사람이 할 일은 없다. 검토 경로는 이 앞에서 이미
  //     같은 조회를 한 번 했다(startReview). 첫 계정 id 가 목록에 없어 provider 를 알 수
  //     없으면 어긋났다고 말할 수 없으므로 건너뛰지 않는다.
  if (task?.accountIds?.length && (taskProvider === undefined || taskProvider === a.provider)) {
    try {
      const loggedInHere = new Set(
        (
          await Promise.all(
            accountList.map(async (x) => ((await ctx.loginStatus(x.id)) ? x.id : null))
          )
        ).filter((id): id is string => id !== null)
      )
      const picked = rollChainFor({
        requested: a.accountId,
        taskAccountIds: task.accountIds,
        provider: a.provider,
        accounts: accountList,
        loggedInIds: loggedInHere
      })
      rollAccountIds = picked.chain
      // 저하한 두 갈래를 갈라 적는다 — 사람이 할 일이 다르다: 앞은 이 Task 의 계정을 아무것도
      // 못 쓴다는 뜻(로그인이 필요하다), 뒤는 하필 이 Dispatch 의 계정만 걸러졌다는 뜻이다.
      if (picked.degraded === 'nothing-usable')
        ctx.log(
          `worker-start: no usable account among ${a.accountId},${task.accountIds.join(',')} ` +
            `for ${a.provider} — rolling chain falls back to ${a.accountId} alone`
        )
      else if (picked.degraded === 'requested-unusable')
        ctx.log(
          `worker-start: the dispatch account ${a.accountId} is not usable, so the chain ` +
            `${task.accountIds.join(',')} is dropped — falls back to ${a.accountId} alone`
        )
    } catch (e) {
      // 로그인 조회는 계정 파일과 Keychain 을 읽으므로 던질 수 있다. 그것이 워커를 못 띄우는
      // 이유가 되어서는 안 된다 — 체인 없이 띄우는 것은 이 목록이 생기기 전의 동작이다.
      ctx.log(
        `worker-start: could not read login status — rolling chain falls back to ` +
          `${a.accountId} alone: ${String(e)}`
      )
    }
  }
  const started = await ctx.coordinator.startWorker({ ...a, rollAccountIds })
  // From this point on, that session's output belongs to this dispatch. On reuse (--terminal) the
  // previous dispatch's tail freezes where it is. Only a dispatch that has reached a terminal
  // state is eligible for eviction — a live worker's tail is not dropped even past the cap (see
  // tail.ts).
  ctx.tails.start({ dispatchId: a.dispatchId, sessionId: started.sessionId }, (id) => {
    const d = ctx.getState().dispatches.find((x) => x.id === id)
    return d === undefined || d.endedAt !== undefined || d.outcome !== undefined
  })
  return started
}

export type StartCoordinatorArgs = Parameters<NonNullable<OrchServerDeps['startCoordinator']>>[0]
export interface CoordinatorStartContext {
  specsDir: string
  preTrust(accountId: string, cwd: string): Promise<void>
  bypassPermissions(): Promise<boolean>
  spawn(o: {
    accountId: string
    cwd: string
    bypassPermissions: boolean
    initialPrompt: string
    title: string
    rollAccountIds: string[]
  }): Promise<{ id: string }>
  log(m: string): void
}

/** 이 Run 을 관리할 코디네이터 세션을 띄운다. **워커가 아니다** — Dispatch 도 spec 파일도
 *  워크트리도 없다. 사람이 여는 세션과 같은 모양이고, 다른 것은 첫 입력이 인수 프롬프트라는
 *  것뿐이다(core/orchestration/handover.ts).
 *
 *  **롤링 체인을 그대로 넘긴다** — 코디네이터도 에이전트라 한도에 걸린다. 워커에게 이 값을
 *  넘기는 것과 같은 이유이고 같은 기계를 탄다(rollAccountIds 의 JSDoc).
 *
 *  **`bypassPermissions` 는 전역 설정이 정한다** — startWorker 와 같은 자리에서 같은 값을
 *  읽는다(AgentPermissionMode). 한동안 이 자리는 그것을 넘기지 않았고, 그 선택은 "멈추는 쪽이
 *  허가 없는 실행에 대해 안전하다" 는 것이었다. 뒤집은 근거는 안전이 덜 중요해져서가 아니라
 *  **멈춤이 실제로는 안전이 아니라 정지였기 때문이다**: 코디네이터는 워크트리가 아니라 프로젝트
 *  루트에서 뜨지만 그가 띄우는 워커는 매번 새 워크트리에서 뜨고, 사람이 그 프로젝트에 쌓아 둔
 *  허용 목록은 거기 따라오지 않는다. 그래서 manual 인 Job 은 자율로 돌라고 띄운 세션이 첫
 *  명령에서 서고, 사람은 탭마다 승인하러 다니게 된다 — 사용자가 보고한 그대로다.
 *
 *  The tab is the caller's business: `spawn` is the caller's adapter, and the app's emits
 *  `session:created` there (registerIpc's startCoordinator). */
export async function startCoordinatorSession(
  ctx: CoordinatorStartContext,
  a: StartCoordinatorArgs
): Promise<{ sessionId: string }> {
  // **브리핑은 파일로, 세션에는 한 줄만.** 이 프롬프트는 argv 로 가고 win32 에서 세션은
  // `cmd.exe /c` 로 뜨므로 줄바꿈이 명령을 끊는다 — 워커의 spec 파일과 탭 재개 브리핑이
  // 같은 제약 때문에 같은 모양으로 갈렸다(coordinatorLaunchPrompt 의 주석).
  //
  // **specsDir 에 쓴다.** 그 경로에 argv 금지 문자가 있으면 앱 시작 시 경고가 남는 자리가
  // 이미 그것이고(bootOrch 의 LAUNCH_FORBIDDEN 검사), 시작 시 비워지는 것도 무해하다: 앱을 다시
  // 켜면 코디네이터도 없으므로 사람이 실행을 다시 누른다.
  //
  // **The last clause stopped being true when the Host started keeping terminals alive**, and
  // the boot no longer relies on it: a coordinator session the Host hands back is still running
  // with this path in its launch prompt, so the boot sweep keeps this file while
  // `Run.coordinatorSessionId` names a session that survived. That is `staleSpecFiles`, which
  // recognises this file by `coordinatorBriefName` — the same function that names it here, so
  // the two cannot drift.
  const briefPath = path.join(ctx.specsDir, coordinatorBriefName(a.runId))
  await fs.writeFile(briefPath, a.brief, 'utf8')
  // 코디네이터는 프로젝트 루트에서 뜨므로 대개 이미 신뢰돼 있다 — 그래도 부른다. 그 Run 을
  // 처음 돌리는 사람에게는 여기가 첫 codex 세션이고, 멈추면 아무도 답할 사람이 없는 것은
  // 워커와 같다(preTrustWorkspace 의 주석).
  await ctx.preTrust(a.accountId, a.cwd)
  // **워커와 같은 래퍼를 쓴다**(the caller's worker spawnSession) — 그 래퍼가 계정 객체를 찾고,
  // 롤링 코디네이터에 등록하고, orchEnv 를 실어 준다. core.sessions.spawn 을 직접 부르면 그 셋을
  // 여기서 다시 하게 되고, 그중 하나를 빠뜨리면 코디네이터는 한도에 걸린 채 멈춰 선다.
  const info = await ctx.spawn({
    accountId: a.accountId,
    cwd: a.cwd,
    bypassPermissions: await ctx.bypassPermissions(),
    initialPrompt: coordinatorLaunchPrompt(briefPath.replace(/\\/g, '/')),
    // 탭 제목 — 워커 탭이 Task 제목을 쓰는 것과 같은 이유다. 없으면 워크트리 basename 으로
    // 떠서 사용자가 이것이 무엇인지 알 수 없다.
    title: `Coordinator · ${a.runId.slice(0, 12)}`,
    // **한 원소다.** 그래서 롤링은 계정을 갈아타지 않고 리셋까지 기다린 뒤 같은 세션에서
    // 이어간다 — 관리 중이던 Run 의 맥락을 잃지 않는 쪽을 골랐다(Run.coordinatorAccountId).
    rollAccountIds: [a.accountId]
  })
  ctx.log(`coordinator started run=${a.runId} session=${info.id} account=${a.accountId}`)
  return { sessionId: info.id }
}

/** Best-effort folder trust for an orchestration spawn (the app's reasoning, moved with it).
 *
 *  Marks the folder behind `cwd` trusted for this account before a session is spawned into it,
 *  so an agent nobody is sitting in front of does not stop at the CLI's "do you trust this
 *  folder?" menu.
 *
 *  **Only the orchestration path calls this**, not the shared `spawnSession` every tab goes
 *  through. The justification is exactly that nobody is there: a worker starts in a worktree made
 *  seconds earlier, which no person has ever approved, and the menu is a wall it cannot get past
 *  on its own — measured, three workers in a row. A person opening a tab is present to answer, and
 *  pre-approving a folder on their behalf would take away a decision they still have.
 *
 *  **Both providers need it.** This used to be codex-only, on the stated grounds that
 *  `--dangerously-skip-permissions` covers claude's trust prompt too. Measured 2026-09-22: it does
 *  not. A Job worker went into a fresh worktree with that flag on its own command line and stopped
 *  at `Yes, I trust this folder`; `~/.claude.json` held 47 project entries and none under the
 *  worktree root, so no claude worker had ever got past it. The flag sets the permission policy,
 *  and trust is a different question — which is what codex's own note said about its bypass flag
 *  all along. Orca's preset module has no claude entry either, and that is the same mistake.
 *
 *  Best-effort for both: a config this cannot write is a menu the agent will meet, not a reason to
 *  refuse to start it. The same convention as the other incidental failures around here. */
export async function preTrustWorkspace(a: {
  account: Account | undefined
  cwd: string
  homeDir: string
  descriptors: Record<Provider, ProviderDescriptor>
  log(m: string): void
}): Promise<void> {
  const account = a.account
  if (!account) return
  try {
    if (providerOf(account) === 'codex') {
      await markCodexProjectTrusted(account.configDir, a.cwd)
      return
    }
    await markClaudeProjectTrusted(
      claudeConfigFileFor({
        configDir: account.configDir,
        homeDir: a.homeDir,
        ambient: isAmbientDir(descriptorOf(a.descriptors, account), a.homeDir, account.configDir)
      }),
      a.cwd
    )
  } catch (e) {
    a.log(`trust preset failed account=${account.id} cwd=${a.cwd}: ${String(e)}`)
  }
}
