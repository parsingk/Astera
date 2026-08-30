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

  /** 이 Unit 을 연 메시지가 **그 세션에서 관찰한** 사람의 요청 중 몇 번째인가 (0-기반). 그 세션의
   *  몇 번째 요청인가가 아니다 — 켠 뒤의 첫 요청은 그 앞에 열 번의 대화가 있었어도 0 이다(스펙 §16.1).
   *  **uuid 를 쓰지 않는 이유:** TranscriptMessage(core/types.ts)는 { role, text, timestamp? }
   *  뿐이고 식별자를 싣지 않는다. 파서를 넓히는 것은 이 계획의 범위 밖이라 재도출 가능한
   *  순번으로 대신한다. */
  firstMessageIndex: number
  messageCount: number

  git: {
    startHead: string | null
    endHead?: string | null
    /** Unit 이 열릴 때 **이미 더러웠던** 파일들. observe 는 이 목록에 없는 파일만 센다.
     *
     *  이것이 없으면 관찰이 "작업 트리 전체의 더러움"이 된다 — 앞 Unit 이 고쳐 놓고 커밋하지
     *  않은 파일이 다음 Unit 에도 세어져, 파일을 하나도 안 바꾼 질문 Unit 이 `completed` 로
     *  확정된다. 설계 §6 이 이 신호를 "git 스냅샷 **비교**"라 부른 이유가 이것이고, §7 의
     *  "관찰된 변경이 없는 Unit 은 abandoned"(WU §4.5 의 근사)가 서는 것도 이 비교 위에서다.
     *  선택 필드인 이유: 이 필드가 생기기 전에 저장된 Unit 은 기준선이 없고, 그때는 전처럼
     *  전부 센다 — 넓게 세는 쪽이 좁게 세는 쪽보다 안전하다(잃는 것이 없다). */
    baselineDirtyFiles?: string[]
    /** **이 구간에 관찰된** 변경. 이 Unit 이 만들었다는 뜻이 아니다 (스펙 §11) */
    observedChangedFiles: string[]
  }

  /** 작업 중 감지된 외부 git 변경 (EG §27). "겪었다"이지 "만들었다"가 아니다 */
  encounteredExternalGitChangeIds: string[]

  /** **V1 은 채우지 않는다** — 검증 결과를 알려면 도구 결과를 파싱해야 하고 그것은 V2 다
   *  (WU §14-2, 스펙 §6).
   *
   *  **그런데도 지금 두는 이유는 마이그레이션이 아니다.** 한동안 여기에 "V2 에서 필드가 늘면 옛
   *  파일이 저장소의 타입 가드를 통과하지 못해 사용자의 기록이 통째로 `.bak` 으로 밀린다"고 적혀
   *  있었는데 **사실이 아니다** — `main/workUnit/store.ts` 의 `isState` 는 네 배열이 배열인지만
   *  보고 `isValid` 는 원소 하나하나의 모양을 아예 보지 않는다(그 파일 주석이 그렇게 하는 이유를
   *  적어 두었다). 그러므로 V2 에서 `SessionWorkUnit` 에 필드가 늘어도 옛 파일은 그대로 읽힌다.
   *  나중에 넣어도 공짜다.
   *
   *  진짜 이유는 이것이다: **WU §10 의 모델과 설계 §12 가 이 이름을 적었고, V2 의 결과가 어디로
   *  들어올지를 미리 이름 지어 두는 편이 읽는 사람에게 낫다.** 설계 §12 의 "V1 이 채우지 않는
   *  필드는 두지 않는다"에 대해 이 필드가 유일한 예외이고, `objective`·`constraints`·`decisions`
   *  는 그 규칙대로 두지 않았다(설계 §17). */
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
  /** **그 세션에서 관찰한** 요청 중 몇 번째인가 (0-기반). 켜기 전의 요청은 세지 않는다 (스펙 §16.1) */
  index: number
  at: string
  text: string
}
