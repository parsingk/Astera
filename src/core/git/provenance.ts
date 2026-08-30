// HEAD 가 움직였을 때 그것이 Astera 의 동작이었는가 — EG §5·§26.
// 이 판정이 있어야 Work Unit 이 남의 작업을 자기 것으로 기록하지 않는다(스펙 §2).
import type { PendingGitOperation } from './types'

/** 동작이 끝난 뒤에도 이만큼은 그 동작의 것으로 본다.
 *
 *  **0 이면 안 되는 이유:** 등록을 지우는 것과 파일 감시자가 이벤트를 받는 것 사이에 순서 역전이
 *  실제로 일어난다. 유예가 없으면 Astera 자신의 병합이 외부 변경으로 잡히고, EG §41-9 가 그것을
 *  통합 테스트 항목("Astera Job merge → External Git 으로 오인하지 않음")으로 적어 두었다. */
export const OPERATION_GRACE_MS = 5_000

/** 망가진 시각 문자열은 없는 것으로 본다 — 저장 파일은 손으로 고쳐질 수 있고, 그때 던지면
 *  감시 고리 전체가 멈춘다. 판정을 못 하면 "Astera 것이 아니다"로 떨어지는 편이 안전하다:
 *  외부로 잘못 보는 것은 기록이 하나 더 생기는 것이지만, Astera 것으로 잘못 보는 것은
 *  변경을 통째로 놓치는 것이다. */
const ms = (iso: string | undefined): number | null => {
  if (iso === undefined) return null
  const n = Date.parse(iso)
  return Number.isFinite(n) ? n : null
}

/**
 * `projectPath`(수집기가 세션의 cwd 에서 뽑은 값)와 `o.projectPath`(등록 자리가 넘긴 값, 예:
 * ipc.ts 의 job-merge 가 넘기는 mergeInto = run.worktree ?? run.cwd)는 **따로 기록된다** — 이
 * 저장소의 다른 곳(core/orchestration/integrate.ts 의 worktreeDeps 주석)이 이미 같은 문제를
 * 적어 두었다: 같은 폴더를 대소문자나 구분자만 다르게 적을 수 있다(Windows 드라이브 문자가 `d:`
 * 와 `D:` 로 갈리는 경우가 그것이다). 그 저장소들은 전부 `isSamePath`(core/files/tree.ts)로
 * 비교하지만, 이 파일은 node: 를 끌고 오지 않는다는 규약이 있어 그 함수를 직접 부르지 못한다 —
 * 그래서 비교 자체를 주입받는다. 기본값은 엄격한 `===`(이 파일의 나머지 테스트가 기대하는 그대로)
 * 이고, 실제 배선(collector.ts)은 `isSamePath` 를 넘긴다.
 */
export function isAsteraOperation(
  projectPath: string,
  atMs: number,
  ops: readonly PendingGitOperation[],
  graceMs: number = OPERATION_GRACE_MS,
  samePath: (a: string, b: string) => boolean = (a, b) => a === b
): boolean {
  return ops.some((o) => {
    if (!samePath(o.projectPath, projectPath)) return false
    const started = ms(o.startedAt)
    if (started === null || started > atMs) return false
    if (o.endedAt === undefined) return true // 아직 도는 중
    const ended = ms(o.endedAt)
    return ended !== null && atMs - ended <= graceMs
  })
}
