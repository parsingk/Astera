// 노드 meta 줄과 사이드바 칩의 **판정**. 렌더러에는 테스트 환경이 없어(vitest 는 environment: 'node') 무엇을
// 그릴지 고르는 규칙을 여기 순수 함수로 두고, 렌더러는 kind 를 t() 로 문장으로 바꾸기만 한다 — core 가 i18n 을
// 모르게, 그리고 문장이 아니라 판정을 테스트하게(UI 설계 U11). 이름이 taskMeta 가 아닌 이유: JobsView.tsx 에
// 이미 사이드바 줄의 경과 문구를 만드는 taskMeta() 가 있다.
import type { JobCheck, JobTask } from '../types'
import type { Provider } from '../providers/meta'

export type NodeMeta =
  | { kind: 'gate'; question: string }
  /** 사람이 이 Task 의 자동 수정을 멈춰 뒀다(설계 §4.2 의 V3). 도는 수리보다 **뒤**, Gate 보다
   *  **앞**은 아니다 — 아래 nodeMetaOf 가 그 자리를 설명한다 */
  | { kind: 'stopped'; failed: string | null }
  | { kind: 'repairing'; repairs: number; max: number; failed: string | null }
  | { kind: 'checking'; retrying: string | null }
  | { kind: 'reviewing'; round: number; max: number }
  | { kind: 'failed'; name: string }
  | { kind: 'provider'; provider: Provider }
  | { kind: 'none' }

/** 마지막 라운드에서 첫 실패(failed·timed-out)한 검사. 첫 실패 뒤는 not-run 이라(validator) 막힌 것은 하나다 */
export const firstBlockedCheck = (task: Pick<JobTask, 'checks'>): JobCheck | null =>
  task.checks?.find((c) => c.status === 'failed' || c.status === 'timed-out') ?? null

/** 그 검사의 이름 — meta 줄이 부르는 것 */
export const firstBlocked = (task: Pick<JobTask, 'checks'>): string | null => firstBlockedCheck(task)?.name ?? null

/** validating 인 Task 에서 **지금 다시 도는 검사**. 검사는 고른 순서로 돌고 첫 실패에서 멈추므로(validator),
 *  다시 도는 순간 화면이 아는 것은 지난 라운드에 어디서 멈췼는가뿐이다(U12) — 그 검사가 다시 도는 중이라는
 *  뜻이라 firstBlockedCheck 를 그대로 가리킨다. **지난 라운드가 막힌 데 없이 전부 통과했을 때**(검토 실패로
 *  되돌아와 다시 validating 이 된 Task — 검토까지 갔다는 것 자체가 지난 라운드는 다 통과했다는 뜻이다)는
 *  firstBlockedCheck 가 null 을 주는데, 거기서 그대로 null 을 돌려주면 칩 줄이 전부 ✓ 로 서서 "지금 도는
 *  검사가 없다"고 거짓말한다 — 실제로는 처음부터 다시 돈다. 그 라운드가 도는 순서는 고른 순서 그대로이므로
 *  가리킬 것은 그 순서의 첫 검사다. validating 이 아니거나 검사 자체가 없으면(첫 라운드) null. */
export const retryingCheckOf = (task: Pick<JobTask, 'status' | 'checks'>): JobCheck | null => {
  if (task.status !== 'validating') return null
  if (!task.checks || task.checks.length === 0) return null
  return firstBlockedCheck(task) ?? task.checks[0]
}

/** 제목 아래 한 줄. 위에서부터 첫 규칙이 이긴다 — Gate 질문 → 막힌 검사 → 도는 검사 → 검토 라운드 → provider.
 *  앞의 셋은 자동 수정 Run 이 아니어도 나온다(U2): 사람이 알아야 할 것은 provider 보다 어느 검사가 막혔는가다(U7). */
export function nodeMetaOf(task: JobTask): NodeMeta {
  if (task.gate) return { kind: 'gate', question: task.gate.question }
  const conv = task.convergence
  // 설계 §4.2(V3). **도는 수리보다 뒤에 본다** — 사람이 멈춤을 눌러도 이미 뜬 수리는 끝까지 가고
  // 그 판정이 Gate 로 온다(server.ts 의 task-update --convergence off). 그 사이에 "멈춤" 이라고
  // 쓰면 지금 돌고 있는 워커가 없는 것처럼 읽힌다. 수리가 끝난 뒤부터 이 줄이 나온다.
  //
  // 이 갈래가 생기기 전에는 멈춘 Task 가 도는 Task 와 똑같은 `수정 2/3` 을 달고 서 있었다 —
  // 첫 조각이 `JobConvergence.stopped` 를 투영에 싣고 아무도 읽지 않은 결과다.
  if (conv?.repairing) return { kind: 'repairing', repairs: conv.repairs, max: conv.maxFixAttempts, failed: firstBlocked(task) }
  if (conv?.stopped) return { kind: 'stopped', failed: firstBlocked(task) }
  // validator 는 라운드 끝에 한 번 결과를 준다 — 도는 동안 화면이 아는 것은 지난 라운드뿐이다(U12). "지금 도는
  // 검사" 를 지어내지 않고 지난 라운드에 막힌 것을 가리킨다: 그것이 다시 도는 중이라는 뜻이다. retryingCheckOf
  // 를 그대로 쓴다 — ● 로 그릴 칩과 여기 문구가 서로 다른 검사를 가리키면 안 되므로 판정을 두 곳에 따로 적지
  // 않는다(RunDetail 이 같은 함수를 쓴다).
  if (task.status === 'validating') return { kind: 'checking', retrying: retryingCheckOf(task)?.name ?? null }
  // reviewRound 는 끝난 라운드 수 — 진행 중인 것은 그다음 번호다. 첫 검토 중에 "0/2" 라고 쓰면 시작도 안 한 것처럼 읽힌다
  if (task.status === 'reviewing' && conv) return { kind: 'reviewing', round: conv.reviewRound + 1, max: conv.maxReviewRounds }
  // failed 상태에만 — --retry-of 로 다시 띄운 dispatched Task 도 지난 라운드의 실패를 들고 있는데, 그 줄이 "실패"
  // 라고 말하면 지금 도는 워커가 없는 것처럼 읽힌다. 거기서는 provider 가 맞다.
  const blocked = firstBlocked(task)
  if (task.status === 'failed' && blocked !== null) return { kind: 'failed', name: blocked }
  if (task.provider) return { kind: 'provider', provider: task.provider }
  return { kind: 'none' }
}

export type ConvergenceChip =
  | { kind: 'repairing'; repairs: number; max: number }
  | { kind: 'reviewing'; round: number; max: number }
  | { kind: 'exhausted' }
  /** 사람이 멈췄다. 사이드바에서도 meta 줄과 같은 것을 말해야 한다 — 두 곳이 어긋나면 어느 쪽이
   *  현재인지 사람이 판단할 수 없다 */
  | { kind: 'stopped' }

/** 사이드바 줄의 칩. convergence 가 없으면 null — 자동 수정 없는 Run 의 줄은 지금 그대로다. 소진은 gate.kind 로만
 *  안다: repairs >= maxFixAttempts 로 되짚으면 사람이 한 번 더 허락한 수정(grantedExtra)이 그 셈을 깨뜨린다. */
export function convergenceChipOf(task: JobTask): ConvergenceChip | null {
  const conv = task.convergence
  if (!conv) return null
  if (task.status === 'blocked' && task.gate?.kind === 'convergence-exhausted') return { kind: 'exhausted' }
  if (conv.repairing) return { kind: 'repairing', repairs: conv.repairs, max: conv.maxFixAttempts }
  // nodeMetaOf 와 같은 순서로 본다 — 도는 수리가 먼저다. 두 함수가 다른 순서를 쓰면 같은 Task 가
  // 노드에서는 "수정 중", 사이드바에서는 "멈춤" 으로 동시에 보인다.
  if (conv.stopped) return { kind: 'stopped' }
  if (task.status === 'reviewing') return { kind: 'reviewing', round: conv.reviewRound + 1, max: conv.maxReviewRounds }
  return null
}

/** 자동 수정 중지 버튼을 내밀 수 있는가 (설계 §4.1).
 *
 *  셋을 모두 본다. 자동 수정 자체가 없는 Task(`convergence` 없음)에는 멈출 것이 없고, 이미 멈춘
 *  Task 에 다시 내밀면 누를 때마다 같은 쓰기가 반복된다. 그리고 **끝난 Task 에는 내밀지 않는다** —
 *  되돌릴 수 없는 버튼이라(서버에 `--convergence on` 이 없다) 아무것도 바꾸지 못하는 자리에서
 *  누르게 하면 안 된다.
 *
 *  `failed` 를 끝난 것으로 치는 이유: 그 Task 는 더 수리되지 않는다. `blocked` 는 끝난 것이 아니다 —
 *  소진 Gate 에 사람이 "한 번 더" 로 답하면 다시 돈다. */
export function canStopConvergence(task: Pick<JobTask, 'status' | 'convergence'>): boolean {
  const conv = task.convergence
  if (!conv || conv.stopped) return false
  return task.status !== 'completed' && task.status !== 'failed'
}
