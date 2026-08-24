// 숨긴 프로젝트의 기록을 지울 때, **무엇을 지워도 되는지 고르는 판정**. 순수 함수다 — 디스크를
// 보지도 지우지도 않고, 실제 삭제(shell.trashItem)는 main 이 한다.
//
// 이 파일이 따로 있는 이유는 지우는 쪽의 실수가 되돌릴 수 없기 때문이다. 경로를 고르는 규칙만
// 떼어 두면 그 규칙에 테스트를 붙일 수 있고, 삭제를 부르는 코드는 여기를 통과한 것만 만진다.
import path from 'node:path'
import { isPathWithin, isSamePath } from '../files/tree'

/** 같은 경로가 표기만 달리해 두 번 들어와도 한 번만 남긴다. 키는 정규화한 값이지만 돌려주는 것은
 *  받은 문자열 그대로다 — 삭제는 원본 경로로 해야 한다. */
function dedupe(paths: string[]): string[] {
  const seen = new Set<string>()
  return paths.filter((p) => {
    const key = path.resolve(p).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 지워도 되는 트랜스크립트 파일들 — 스캔 루트 **밑**에 있는 `.jsonl` 만.
 *
 * 후보는 HistoryEntry.filePath 에서 온다. 그 목록은 이미 프로젝트별로 걸러져 있지만, 이 판정은
 * 그것을 믿지 않는다. 슬러그 해석이나 cwd 파싱이 어긋나 엉뚱한 경로가 섞여도 여기서 걸린다.
 *
 * **확장자까지 보는 이유**: 스캔 루트 안에는 트랜스크립트가 아닌 파일도 있다(설정, 잠금 파일).
 * 경로 경계만 보면 그런 것까지 지울 수 있는데, 우리가 지우려는 것은 언제나 세션 파일 하나다.
 *
 * 루트 자신은 제외한다 — isPathWithin 은 "그 자리이거나 그 아래"라 루트와 같은 경로도 참이다.
 */
export function deletableTranscripts(files: string[], scanRoots: string[]): string[] {
  return dedupe(
    files.filter(
      (f) =>
        f.toLowerCase().endsWith('.jsonl') &&
        scanRoots.some((root) => isPathWithin(root, f) && !isSamePath(root, f))
    )
  )
}

/**
 * 파일을 지운 뒤 비었으면 함께 치울 디렉터리들 — 스캔 루트의 **직계 자식**만.
 *
 * 이 한 조건이 provider 를 가른다. claude 는 `projects/<슬러그>` 라 직계 자식이고, 그 프로젝트의
 * 파일을 모두 지우면 남는 것이 없다. codex 는 `sessions/<년>/<월>/<일>` 이라 직계 자식이 아니고,
 * 애초에 그 날짜 디렉터리에는 **다른 프로젝트의 세션이 남아 있다**. 그래서 후자는 고르지 않는다.
 *
 * 비었는지는 여기서 보지 않는다(디스크를 보지 않으므로). 고른 뒤 실제로 비었을 때만 지우는 것은
 * 부르는 쪽의 몫이다.
 */
export function prunableDirs(dirs: string[], scanRoots: string[]): string[] {
  return dedupe(dirs.filter((d) => scanRoots.some((root) => isSamePath(root, path.dirname(d)))))
}
