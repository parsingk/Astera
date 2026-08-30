// 프로젝트의 뼈대를 읽어 온다 — 스펙 §29 의 "deterministic context collection".
//
// 파일을 읽는 것은 main 의 일이고, 무엇을 실을지·어떻게 자를지는 core/understanding/context.ts 가
// 정한다. 그 갈래는 이 저장소 전체와 같다.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  DOC_CANDIDATES,
  orderDirectories,
  SKIP_DIRS,
  type ProjectSketch
} from '../../core/understanding/context'

/** 문서에서 실을 앞부분. 전체를 실으면 README 하나가 프롬프트를 삼킨다 */
const DOC_HEAD = 1200
/** 훑을 깊이. 3 이면 `src/core/understanding` 까지 보인다 — 그보다 깊은 곳의 이름은
 *  기능이 아니라 구현 세부다 */
const MAX_DEPTH = 3

/** 디렉터리 뼈대와 문서 앞부분. **던지지 않는다** — 못 읽은 것은 없는 것으로 둔다:
 *  재료가 조금 부족한 것은 생성이 아예 안 되는 것보다 낫고, 근거 검증(§28)이 뒤를 받친다. */
export async function collectSketch(projectRoot: string): Promise<ProjectSketch> {
  const dirs: string[] = []

  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(path.join(projectRoot, rel), { withFileTypes: true })
    } catch {
      return // 권한이 없거나 사라졌다 — 그 가지만 접는다
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
      const child = rel === '' ? e.name : `${rel}/${e.name}`
      dirs.push(child)
      await walk(child, depth + 1)
    }
  }
  await walk('', 1)

  const docs: ProjectSketch['docs'] = []
  for (const cand of DOC_CANDIDATES) {
    try {
      const text = await fs.readFile(path.join(projectRoot, cand), 'utf8')
      const head = text.slice(0, DOC_HEAD).trim()
      if (head !== '') docs.push({ path: cand, head })
    } catch {
      continue // 없는 후보 — 정상이다
    }
    if (docs.length >= 2) break // 둘이면 충분하다. 셋째부터는 같은 말의 반복이다
  }

  return { directories: orderDirectories(dirs), docs }
}
