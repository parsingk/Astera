// 저장소 상태의 전이를 말하는 값들 — EG §22·§26.
// **workUnit 을 import 하지 않는다.** 이 층은 Work Unit 없이도 뜻이 서고, EG §17 이 "External Git
// 감지만 독립적으로 구현 가능해야 한다"고 못박았다 — 다음 계획이 이 층만 따로 쓴다.
// node: import 없음.

/** EG §22. 판정할 수 없으면 `unknown` — 억지로 추정하지 않는다 */
export type GitTransitionType =
  | 'none'
  | 'fast-forward'
  | 'branch-switch'
  | 'history-rewritten'
  | 'unknown'

export interface ExternalGitChange {
  id: string
  projectPath: string
  type: GitTransitionType
  before: GitRef
  after: GitRef
  /** fast-forward 일 때만 채운다. 그 밖에는 before..after 범위를 신뢰할 수 없다 */
  commits: string[]
  /** 그 구간의 커밋을 쓴 사람들, 중복 없이 (EG §6 의 `Authors`). `commits` 와 **같은 범위에서
   *  같은 이유로** 오므로 채우는 조건도 같다 — fast-forward 밖에서는 비운다.
   *
   *  **이름 목록일 뿐이다.** EG §7 이 "Kim 이 인증 기능을 만들었습니다" 라고 단정하지 말라고
   *  못박았다 — cherry-pick·rebase·머지·짝 작업·자동화가 전부 이 자리에 남으므로, 이 값이 답하는
   *  것은 "누가 만들었나"가 아니라 "당겨온 커밋들에 어떤 이름이 있었나" 하나다. 표시는 다음
   *  계획이지만 수집은 여기서 한다(EG §37 의 V1 P0 "git pull / fast-forward detection" 이 곧
   *  §6 이고, §38·§39 어디도 이것을 미루지 않는다).
   *
   *  **선택 필드인 이유는 `validation` 과 다르다.** 저장소의 타입 가드는 원소 모양을 보지 않으므로
   *  (`main/workUnit/store.ts` 의 `isValid` 주석) 필수로 두어도 옛 파일은 그대로 읽힌다. 그러면
   *  **읽힌 그 옛 기록이 이 필드를 가졌다고 타입이 거짓말을 한다** — 이 필드가 생기기 전에 쓰인
   *  `ExternalGitChange` 에는 이 값이 실제로 없다. */
  authors?: string[]
  changedFiles: string[]
  detectedAt: string
}

/** EG §26. Astera 가 git 을 건드리기 **직전에** 등록하고 끝나면 endedAt 을 채운다 */
export interface PendingGitOperation {
  id: string
  kind: 'job-merge' | 'checkout' | 'commit' | 'other'
  projectPath: string
  startedAt: string
  endedAt?: string
}

/** 저장소가 어디에 있었는가. `ExternalGitChange` 의 before/after 가 이 모양이다 */
export interface GitRef {
  /** detached HEAD 면 null */
  branch: string | null
  /** 커밋이 하나도 없는 저장소면 null */
  head: string | null
}
