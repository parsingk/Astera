/** 탭이 하나도 없을 때의 현재 프로젝트. App.tsx 의 currentProject 가 활성 탭의 루트 다음으로
 *  읽는 값이고, 여기에 있는 이유는 하나다 — 렌더러에는 테스트가 없어서(vitest 는
 *  environment: 'node' 로 돈다) App.tsx 안에 두면 영속 규칙을 확인할 방법이 없다.
 *
 *  경로는 저장한 그대로 돌려준다. 정규화는 main 의 몫이고(core/history/index.ts 의 norm),
 *  여기에 두 번째 규칙을 두면 둘이 갈라졌을 때 어느 쪽이 틀렸는지 알 수 없다 —
 *  hiddenProjects.ts 와 같은 판단이다.
 *
 *  **읽은 값이 아직 쓸 수 있는지는 여기서 알 수 없다.** 프로젝트 폴더가 사라졌거나 main 의
 *  경로 가드가 더는 허용하지 않을 수 있다. 채택 전 검증은 App.tsx 가 files.list 로 한다. */

const KEY = 'cm.currentProject'

export function read(): string | null {
  try {
    const raw = localStorage.getItem(KEY)
    // 빈 값은 없는 것으로 본다. 빈 경로가 흘러가면 files.list 가 프로젝트 루트가 아닌 곳을
    // 읽으려 들고, 화면에 나오는 실패는 저장값이 원인이라는 것을 알려주지 않는다
    return raw && raw.trim() !== '' ? raw : null
  } catch {
    // 저장소가 꺼져 있는 경우 — 이것은 표시용 기억이므로 던지는 것보다 잊는 것이 낫다
    return null
  }
}

export function write(projectPath: string): void {
  try {
    localStorage.setItem(KEY, projectPath)
  } catch {
    // 용량 초과나 저장소 비활성 — 이번 실행에서는 App.tsx 의 state 가 값을 들고 있으므로
    // 화면은 정상이고, 재시작 후에만 잊는다
  }
}

export function clear(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // read 와 같은 이유로 삼킨다
  }
}
