// 바뀐 파일들이 어느 기능의 일인가 — 경로 겹침으로 정한다.
//
// **AI 를 부르지 않는다.** 기능마다 구현 경로 목록(ImplementationRef.path)이 이미 있고,
// 바뀐 파일이 그 경로와 겹치면 그 기능의 변화다. 겹침이 없으면 빈 목록이다 — 새 기능을
// 지어내는 것은 이 함수의 일이 아니다(설계 §3: "혼자 판단해 목록을 늘리지 않는다").
//
// node: import 없음.

export interface FeatureImplementation {
  featureId: string
  /** 저장소 상대 경로들. 파일일 수도 디렉터리일 수도 있다 — ImplementationRef.path 그대로 */
  paths: readonly string[]
}

/** 양쪽 경로를 같은 모양으로. git status 는 늘 슬래시를 주지만 에이전트가 만든 구현 경로는
 *  역슬래시나 앞의 ./ 를 달고 올 수 있다 — 새 정규화가 아니라 비교 직전의 표기 통일이다 */
const canon = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')

/** 파일 하나가 구현 경로 하나에 속하는가 — 같거나, 그 디렉터리 아래다 */
const belongs = (file: string, implPath: string): boolean =>
  file === implPath || file.startsWith(implPath + '/')

/** 바뀐 파일들과 겹치는 기능 id 들, **겹친 파일 수 내림차순**. 여러 기능이 겹치면 전부
 *  돌려준다 — 한 작업이 두 기능을 고치는 것은 흔하고, 어느 하나를 고르는 것은 정보를 버리는
 *  것이다. 같은 수면 features 에 온 순서(사이드바 순서)를 지킨다. */
export function mapFilesToFeatures(
  changedFiles: readonly string[],
  features: readonly FeatureImplementation[]
): string[] {
  const files = changedFiles.map(canon)
  const hits: { featureId: string; count: number }[] = []
  for (const f of features) {
    const paths = f.paths.map(canon).filter((p) => p !== '')
    const count = files.filter((file) => paths.some((p) => belongs(file, p))).length
    if (count > 0) hits.push({ featureId: f.featureId, count })
  }
  // sort 는 안정적이다(ES2019+) — 같은 count 의 상대 순서가 features 순서로 남는다
  return hits.sort((a, b) => b.count - a.count).map((h) => h.featureId)
}
