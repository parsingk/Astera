// 두 CLI 의 모델을 하나의 모양으로 — 어느 쪽 응답도 화면과 설정에 그대로 노출하지 않는다.
//
// node: import 없음 — 렌더러와 main 이 함께 읽는다.

export interface ModelDescriptor {
  provider: 'claude' | 'codex'
  /** CLI 의 `--model` / `-m` 에 그대로 넘길 값 */
  id: string
  /** 사람이 읽는 이름 — 드롭다운에 뜨는 것 */
  name: string
  description?: string
  /** 이 계정의 기본 모델. 사용자가 아무것도 안 고르면 CLI 가 이것을 쓴다 */
  isDefault?: boolean
  /** `id` 가 가리키는 정식 모델 이름 (claude 의 `resolvedModel`). `id: 'default'` 줄에서는 이 계정의
   *  기본 모델이 실제로 무엇인지 말해 주는 유일한 값이다 — CLI 는 첫 턴이 시작되기 전까지 현재
   *  모델을 따로 알려 주지 않으므로(system/init 은 턴과 함께 온다), 그 전에 화면이 보여 줄 수 있는
   *  것은 이것뿐이다. codex 는 이 필드가 없다. */
  resolvedModel?: string
  /** 이 모델이 받는 추론 강도. 없으면 강도를 안 받는 모델이다 */
  effortLevels?: string[]
  /** 강도를 지정하지 않았을 때의 값 */
  defaultEffort?: string
}

/** 목록 조회의 결과. **실패도 값으로 돌려준다** — 조회는 정상적으로 실패할 수 있고
 *  (claude 미로그인, codex app-server 가 experimental), 그때 화면은 목록 대신 자유 입력칸을
 *  보여 주면서 왜 그런지 말해야 한다. 던지면 그 사유가 사라진다. */
export interface ModelListResult {
  models: ModelDescriptor[]
  /** 목록을 못 받은 이유. 성공이면 없다 */
  error?: string
}
