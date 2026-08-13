// 파일 탭에 쓸 이름과, 이름이 겹칠 때만 붙는 구분자.
//
// 겹칠 때만 붙이는 것은 IntelliJ("Show directory in editor tabs for non-unique filenames")와 VS Code
// (workbench.editor.labelFormat 기본값)가 둘 다 고른 규칙이다. 항상 붙이면 탭이 길어지고 정작 파일명이
// 잘린다. 서로 다른 프로젝트의 같은 이름도 이 규칙 하나로 덮인다 — 갈라지는 조각이 프로젝트 쪽에서
// 나올 뿐이다.
// node: import 없음 — 렌더러가 import한다.

export interface TabLabel {
  name: string
  /** 겹치지 않으면 null. 겹치면 서로를 구분하는 최소한의 상위 경로 조각 */
  hint: string | null
}

/** 경로를 조각으로. 구분자는 섞여 있을 수 있다(윈도우 경로에 슬래시가 들어오기도 한다) */
const segmentsOf = (p: string): string[] => p.split(/[\\/]/).filter((s) => s !== '')

export function tabLabels(paths: string[]): Map<string, TabLabel> {
  const out = new Map<string, TabLabel>()
  const byName = new Map<string, string[]>()
  for (const p of paths) {
    const segs = segmentsOf(p)
    const name = segs[segs.length - 1] ?? p
    const list = byName.get(name)
    if (list) list.push(p)
    else byName.set(name, [p])
  }

  for (const [name, group] of byName) {
    if (group.length === 1) {
      out.set(group[0], { name, hint: null })
      continue
    }
    // 같은 깊이를 그룹 전체에 적용한다 — 탭마다 다른 깊이를 쓰면 나란히 놓았을 때 읽기 어렵다.
    // 모두 서로 달라지는 가장 얕은 깊이를 찾고, 경로가 짧아 더 올라갈 수 없으면 거기서 멈춘다.
    const segs = new Map(group.map((p) => [p, segmentsOf(p)]))
    const maxDepth = Math.max(...group.map((p) => segs.get(p)!.length - 1))
    let depth = 1
    for (; depth < maxDepth; depth++) {
      const hints = group.map((p) => hintAt(segs.get(p)!, depth))
      if (new Set(hints).size === group.length) break
    }
    for (const p of group) out.set(p, { name, hint: hintAt(segs.get(p)!, depth) })
  }
  return out
}

/** 파일명 바로 위 depth개의 조각. 표시용이므로 구분자는 항상 슬래시로 낸다 */
function hintAt(segs: string[], depth: number): string {
  return segs.slice(Math.max(0, segs.length - 1 - depth), segs.length - 1).join('/')
}
