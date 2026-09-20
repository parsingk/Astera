// 노드 meta 줄과 사이드바 칩의 **판정**. 렌더러에는 테스트 환경이 없어(vitest 는 environment: 'node') 무엇을
// 그릴지 고르는 규칙을 여기 순수 함수로 두고, 렌더러는 kind 를 t() 로 문장으로 바꾸기만 한다 — core 가 i18n 을
// 모르게, 그리고 문장이 아니라 판정을 테스트하게(UI 설계 U11). 이름이 taskMeta 가 아닌 이유: JobsView.tsx 에
// 이미 사이드바 줄의 경과 문구를 만드는 taskMeta() 가 있다.
import type { JobCheck, JobTask } from '../types'
import type { Provider } from '../providers/meta'

export type NodeMeta =
  | { kind: 'gate'; question: string }
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

/** 제목 아래 한 줄. 위에서부터 첫 규칙이 이긴다 — Gate 질문 → 막힌 검사 → 도는 검사 → 검토 라운드 → provider.
 *  앞의 셋은 자동 수정 Run 이 아니어도 나온다(U2): 사람이 알아야 할 것은 provider 보다 어느 검사가 막혔는가다(U7). */
export function nodeMetaOf(task: JobTask): NodeMeta {
  if (task.gate) return { kind: 'gate', question: task.gate.question }
  const conv = task.convergence
  if (conv?.repairing) return { kind: 'repairing', repairs: conv.repairs, max: conv.maxFixAttempts, failed: firstBlocked(task) }
  // validator 는 라운드 끝에 한 번 결과를 준다 — 도는 동안 화면이 아는 것은 지난 라운드뿐이다(U12). "지금 도는
  // 검사" 를 지어내지 않고 지난 라운드에 막힌 것을 가리킨다: 그것이 다시 도는 중이라는 뜻이다.
  if (task.status === 'validating') return { kind: 'checking', retrying: firstBlocked(task) }
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

/** 사이드바 줄의 칩. convergence 가 없으면 null — 자동 수정 없는 Run 의 줄은 지금 그대로다. 소진은 gate.kind 로만
 *  안다: repairs >= maxFixAttempts 로 되짚으면 사람이 한 번 더 허락한 수정(grantedExtra)이 그 셈을 깨뜨린다. */
export function convergenceChipOf(task: JobTask): ConvergenceChip | null {
  const conv = task.convergence
  if (!conv) return null
  if (task.status === 'blocked' && task.gate?.kind === 'convergence-exhausted') return { kind: 'exhausted' }
  if (conv.repairing) return { kind: 'repairing', repairs: conv.repairs, max: conv.maxFixAttempts }
  if (task.status === 'reviewing') return { kind: 'reviewing', round: conv.reviewRound + 1, max: conv.maxReviewRounds }
  return null
}
