// 주어진 프로젝트 루트에 속한 세션을 고른다. 에디터 모드의 탭 줄이 어떤 세션을 보여줄지가 여기서
// 결정된다.
// SessionInfo에는 프로젝트 소속 필드가 없고 cwd만 있으므로(types.ts) 판별은 cwd 비교다. 그 결과
// worktree 세션은 부모 프로젝트에 잡히지 않는데, worktree 세션은 그 worktree 폴더를 열었을 때 보이는
// 것이 옳으므로 맞는 동작이다.
// node: import 없음 — 렌더러가 import한다. 그래서 정규화에 path.resolve를 쓰지 않는다. 두 입력 모두
// main이 만든 절대 경로이므로 resolve가 필요하지 않다. 소문자화를 무조건 하는 것은 win32를 우선하는
// 기존 관례를 따른 것이다(accounts/registry.ts).
import type { SessionInfo } from '../types'

const normalize = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export function sessionsOfProject(
  sessions: SessionInfo[],
  root: string | null
): SessionInfo[] {
  if (!root) return []
  const target = normalize(root)
  return sessions.filter((s) => normalize(s.cwd) === target)
}
