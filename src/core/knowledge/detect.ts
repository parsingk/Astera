/** 프로젝트가 자기 지식을 두는 흔한 자리들. **자기 관례 하나만 보지 않는다** — knowledge/README.md
 *  가 이 기능에 대해 그 결정을 미리 적어 두었다: 대부분의 저장소는 `docs/adr/` 이나
 *  `docs/decisions/` 를 쓰므로, 자기 관례만 찾는 도구는 그 밖에서 아무것도 찾지 못한다.
 *
 *  순서가 곧 목록에 서는 순서는 아니다 — 모은 뒤 정렬한다(knowledgeFilesFrom). 이 순서는 훑는
 *  순서일 뿐이다. */
export const KNOWLEDGE_DIRS: readonly string[] = [
  'knowledge',
  'docs/adr',
  'docs/decisions',
  'docs/architecture',
  'adr',
  'doc/adr'
]

/** spec 에 적는 경로의 상한. **디렉터리별이 아니라 전체다** — 여섯 관례를 다 가진 저장소에서
 *  디렉터리마다 40개면 240줄이 되고, 그것은 spec 을 읽는 워커에게 목록이 아니라 벽이다. */
export const KNOWLEDGE_MAX = 40

export interface KnowledgeFiles {
  /** spec 에 적을 상대 경로들. 정렬돼 있고 중복이 없다 */
  paths: string[]
  /** 상한 때문에 빠진 개수. 0 이면 다 실렸다. **이 값이 있는 이유는 조용히 자르지 않기 위해서다** —
   *  자른 것을 말하지 않으면 그 목록이 "이게 전부"로 읽힌다 */
  more: number
}

/** 모은 상대 경로들을 spec 에 실을 모양으로 만든다.
 *
 *  **정렬하는 이유는 결정성이다.** readdir 의 순서는 플랫폼과 파일 시스템이 정하므로, 정렬하지
 *  않으면 같은 저장소에서 두 번 띄운 워커가 다른 spec 을 받는다.
 *
 *  디스크를 읽지 않는다 — fs 는 부르는 쪽(main)의 일이고, 여기는 무엇을 고를지만 정한다
 *  (main/run/prepare.ts 의 loadRunConfigs 와 같은 갈래다). */
export function knowledgeFilesFrom(found: string[]): KnowledgeFiles {
  const sorted = [...new Set(found)].sort()
  return {
    paths: sorted.slice(0, KNOWLEDGE_MAX),
    more: Math.max(0, sorted.length - KNOWLEDGE_MAX)
  }
}
