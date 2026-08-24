/** 설정 모달 히스토리 탭의 숨긴 프로젝트 목록을 화면에 낼 모양으로 계산한다 — 검색 필터와 페이지
 *  자르기, 그리고 범위를 벗어난 페이지 번호 보정까지.
 *  hiddenProjects.ts(저장소)와 나눠 둔 이유는 두 가지다. 저장소는 무엇이 숨겨져 있는지만 알면 되고
 *  여기는 그것을 어떻게 보여줄지만 알면 된다는 것, 그리고 이 계산이 순수 함수라야 컴포넌트 테스트
 *  없이 경계 조건을 테스트할 수 있다는 것(이 저장소의 렌더러 테스트는 전부 lib 의 순수 로직이다). */

export interface HiddenProjectsView {
  /** 이 페이지에 그릴 경로들 */
  rows: string[]
  /** 실제로 쓰인 페이지 번호(0-based). 넘겨받은 값이 범위 밖이면 보정된 값이다 */
  page: number
  /** 검색 결과 기준 전체 페이지 수. 결과가 없어도 1이다 — 0이면 화면에 '0 / 0'이 나온다 */
  pages: number
  /** 검색과 무관한, 숨긴 프로젝트 전체 개수 */
  total: number
  /** 검색에 걸린 개수 */
  matched: number
  /** 검색에 걸린 것 전체 — 페이지로 자르기 전. 설정 화면의 '보이는 것 모두 선택'이 현재 페이지가
   *  아니라 좁힌 결과 전체를 고르기 위해 필요하다 */
  matchedAll: string[]
}

/** 대소문자와 경로 구분자를 지운 비교용 문자열. 사용자가 경로를 `\`로 치는지 `/`로 치는지는 그때그때
 *  다르고, 그 차이로 목록에 있는 항목이 안 잡히면 없는 것처럼 보인다.
 *  core/history 의 norm()과 규칙이 겹쳐 보이지만 일부러 따로 둔다 — 그쪽은 두 경로가 같은 프로젝트인지
 *  판정하는 것이고 이쪽은 부분 문자열 검색이라, 한쪽 규칙이 바뀌어도 다른 쪽이 끌려가면 안 된다. */
function cmp(s: string): string {
  return s.toLowerCase().replace(/\\/g, '/')
}

export function viewOf(
  all: string[],
  query: string,
  page: number,
  pageSize: number
): HiddenProjectsView {
  const q = cmp(query.trim())
  const matched = q === '' ? all : all.filter((p) => cmp(p).includes(q))
  const pages = Math.max(1, Math.ceil(matched.length / pageSize))
  // 페이지를 지우거나 검색어를 좁히면 현재 페이지가 범위 밖으로 남는다. effect 로 되돌리면 그 한 프레임
  // 동안 빈 목록이 보이므로 렌더 시점에 여기서 잡는다.
  const safe = Math.min(Math.max(0, page), pages - 1)
  return {
    rows: matched.slice(safe * pageSize, safe * pageSize + pageSize),
    page: safe,
    pages,
    total: all.length,
    matched: matched.length,
    // 검색어가 없으면 matched 는 넘겨받은 배열 그 자체다 — 복사해서 내보낸다(저장소의 배열을 쥐여 주지 않는다)
    matchedAll: [...matched]
  }
}
