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

export interface GitRef {
  name: string
  hash: string
}
