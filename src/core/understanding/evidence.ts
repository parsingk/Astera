// 근거 하나의 id.
//
// **경로에서 결정적으로 만든다.** 무작위 id 를 쓰면 재생성할 때마다 값이 바뀌고, 그러면 그 id 를
// 들고 있던 것들 — 최근 변경 줄, 지난 설명의 단계 — 이 다음 생성의 어떤 근거와도 겹치지 않는다.
// 오른쪽 단이 좁혀지는 것은 오직 이 겹침이므로(scope.ts 의 overlaps), 그 순간 화면의 절반이
// 조용히 빈다. 같은 파일은 언제 만들어도 같은 id 여야 한다.
//
// 접두사를 두는 이유: 지금은 근거가 전부 소스 파일이지만 타입이 일곱 가지고(types.ts 의
// EvidenceType), 나중에 커밋이나 세션이 근거로 들어와도 경로와 부딪히지 않는다.

/** 저장소 상대 경로 하나의 근거 id */
export const evidenceIdOf = (repoRelativePath: string): string => `file:${repoRelativePath}`
