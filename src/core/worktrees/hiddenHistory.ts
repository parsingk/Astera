// 히스토리 목록에서 감출 프로젝트를 고르는 판정. **순수 함수다** — 존재 확인은 주입받고, 실제
// 필터링은 core/history 의 projectsPage 가 이미 갖고 있는 hiddenPaths 로 한다(배선은 src/main/ipc.ts).
// 여기에 fs 를 두지 않는 이유: core/history 는 디스크를 io 추상화를 통해서만 보고, 그 규율을 이
// 판정이 우회하면 그 층의 테스트가 실제 디스크에 의존하게 된다.
import { isPathWithin, isSamePath } from '../files/tree'

/**
 * 앱이 만들고 지운 워크트리의 스크래치 프로젝트 경로들 — 히스토리에서 감출 것.
 *
 * **감추는 것이지 지우는 것이 아니다.** 세션 트랜스크립트는 워크트리가 아니라 provider 의 설정
 * 디렉터리(`~/.claude` 등)에 남아 있어서 폴더가 사라져도 파일은 그대로다. 그래서 이 판정이 하는
 * 일은 목록에서 빼는 것뿐이고, 파일을 건드리지 않는다.
 *
 * **왜 "폴더가 없는 프로젝트" 전부가 아닌가.** 사용자가 지운 *실제* 프로젝트도 폴더가 없다 — 그
 * 기록은 나중에 읽고 싶을 수 있는 것이라(트랜스크립트가 남아 있다) 감추면 잃는 것이 생긴다.
 * 조건을 **워크트리 루트 밑**으로 좁히면 앱이 스스로 만들고 스스로 지운 스크래치만 걸린다 —
 * 예약 작업이 회차마다 워커 수만큼 만들어 히스토리를 채우던 그것이다.
 *
 * 루트 자신은 제외한다. `isPathWithin` 은 "그 자리이거나 그 아래"라서 루트와 같은 경로도 참인데,
 * 루트는 워크트리가 아니라 그것들을 담는 폴더다 — 루트가 없어졌다고 그 이름의 프로젝트를 감추는
 * 것은 이 판정이 말하려는 것이 아니다.
 *
 * 비교와 정규화는 isPathWithin 에 맡긴다(win32 의 대소문자·구분자 규칙이 그 안에 있다). 돌려주는
 * 문자열은 받은 값 그대로다 — 정규화한 값을 주면 hiddenPaths 쪽에서 다시 정규화하는 값과 어긋날
 * 이유를 만든다.
 */
export function goneWorktreeProjects(
  projectPaths: readonly string[],
  worktreeRoot: string,
  exists: (p: string) => boolean
): string[] {
  return projectPaths.filter(
    (p) => isPathWithin(worktreeRoot, p) && !isSamePath(worktreeRoot, p) && !exists(p)
  )
}
