// 탭 식별자. 페인이 담는 탭은 세션이거나 파일이고, 트리는 그 구분을 몰라야 하므로(tree.ts 머리주석의
// core 규약) 트리에는 불투명한 문자열만 들어간다. 그 문자열을 만들고 해석하는 책임이 이 모듈에 있다.
// 파일 탭 id는 이 모듈이 생기기 전부터 `file:${path}` 형식이었다(FileTabs.tsx의 FileTab.id) — 새 형식을
// 도입하는 것이 아니라 흩어져 있던 형식을 한 곳으로 모으는 것이다.
// node: import 없음 — 렌더러가 import한다.
export type TabKind = 'session' | 'file' | 'feature'
export type TabRef = { kind: TabKind; id: string }

export const sessionTab = (sessionId: string): string => `session:${sessionId}`
export const fileTab = (path: string): string => `file:${path}`
/** How It Works 의 기능 상세. 세션·파일과 같은 줄에 서고, 트리는 이 셋을 구별하지 않는다 */
export const featureTab = (featureId: string): string => `feature:${featureId}`

/** 탭 id가 아닌 문자열은 null — 던지지 않는다. 저장된 옛 상태나 다른 종류의 id를 만나도 화면이 죽지
 *  않아야 한다. Windows 경로의 드라이브 콜론 때문에 쪼개기는 첫 콜론에서만 한다. */
export function parseTab(tabId: string): TabRef | null {
  const i = tabId.indexOf(':')
  if (i <= 0) return null // 콜론이 없거나 맨 앞에 있으면 종류가 없다
  const kind = tabId.slice(0, i)
  const id = tabId.slice(i + 1)
  if (id === '') return null
  return kind === 'session' || kind === 'file' || kind === 'feature' ? { kind, id } : null
}
