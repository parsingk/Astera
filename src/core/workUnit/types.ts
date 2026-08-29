// Work Unit 감지가 다루는 값들. 스펙 §12 의 모델을 그대로 옮겼다.
// node: import 없음 — main 과 core 가 함께 읽는다.

/** WU §10 의 상태. `superseded` 는 분류기가 있어야 판정할 수 있어 V1 에 없다 */
export type WorkUnitStatus = 'active' | 'completed-candidate' | 'completed' | 'abandoned'

export interface SessionWorkUnit {
  id: string
  sessionId: string
  projectPath: string

  /** Unit 을 연 메시지를 한 줄로 다듬은 것. AI 정규화는 V2 (WU §16) */
  title: string
  status: WorkUnitStatus

  startedAt: string
  completedAt?: string

  /** 이 Unit 을 연 메시지가 그 세션에서 몇 번째 사람의 요청인가 (0-기반).
   *  **uuid 를 쓰지 않는 이유:** TranscriptMessage(core/types.ts)는 { role, text, timestamp? }
   *  뿐이고 식별자를 싣지 않는다. 파서를 넓히는 것은 이 계획의 범위 밖이라 재도출 가능한
   *  순번으로 대신한다. */
  firstMessageIndex: number
  messageCount: number

  git: {
    startHead: string | null
    endHead?: string | null
    /** **이 구간에 관찰된** 변경. 이 Unit 이 만들었다는 뜻이 아니다 (스펙 §11) */
    observedChangedFiles: string[]
  }

  /** 작업 중 감지된 외부 git 변경 (EG §27). "겪었다"이지 "만들었다"가 아니다 */
  encounteredExternalGitChangeIds: string[]

  /** **V1 은 채우지 않는다** — 검증 결과를 알려면 도구 결과를 파싱해야 하고 그것은 V2 다
   *  (WU §14-2, 스펙 §6).
   *
   *  그런데도 지금 두는 이유: 이 파일은 사용자의 디스크에 남고 저장소가 타입 가드로 읽는다.
   *  V2 에서 필드가 늘면 옛 파일이 그 가드를 통과하지 못하고, 그때 사용자의 기록이 통째로
   *  `.bak` 으로 밀린다. 선택적 필드를 미리 두면 그 마이그레이션이 아예 없다. */
  validation?: { status: 'passed' | 'failed' | 'unknown'; summary?: string }
}

/** 트랜스크립트를 어디까지 읽었는가 (스펙 §16.3). 세션마다 하나 */
export interface TranscriptCursor {
  sessionId: string
  /** 읽고 있던 파일. 세션이 fork(resume) 되면 달라진다 */
  filePath: string
  /** 다음에 여기서부터 읽는다. 마지막 개행 다음 바이트다 */
  offset: number
  /** 마지막으로 읽었을 때의 파일 크기. 이보다 작아졌으면 잘렸거나 다른 파일이다 */
  sizeAtRead: number
}

/** 우리가 실제로 본 사용자 메시지. **저장하는 이유는 스펙 §16.1 이다** — 규칙이 바뀌었을 때
 *  원본 트랜스크립트를 다시 읽지 않고 여기서 다시 도출한다. 실측으로 55MB 파일당 15KB 다 */
export interface ObservedUserMessage {
  sessionId: string
  /** 그 세션에서 몇 번째 사람의 요청인가 (0-기반) */
  index: number
  at: string
  text: string
}
