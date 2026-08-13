import path from 'node:path'

/** 지금 도는 플랫폼의 절대 경로를 만든다 — win32면 `D:\a\b`, 그 외에는 `/a/b`.
 *
 *  경로를 다루는 테스트들이 `'D:\\work\\proj'` 같은 Windows 문자열을 그대로 박아 두고 있었다.
 *  POSIX의 path.resolve는 `\`를 구분자로 보지 않으므로 그 값은 세 칸짜리 경로가 아니라 이름
 *  하나가 되고, "하위 경로인가" 같은 판정이 전부 무너진다. 제품이 틀린 것이 아니라 테스트가
 *  Windows에서만 실행된다는 전제 위에 있었던 것이다 — 스위트가 저장소에 공개되어 CI가 macOS에서
 *  돌리기 시작하고 나서야 드러났다.
 *
 *  드라이브 문자를 쓰는 이유: win32에서 `\a\b`는 현재 드라이브에 의존하는 상대 경로라서, 절대
 *  경로를 전제하는 판정에 쓰면 실행 위치에 따라 결과가 달라진다. */
export const absPath = (...segments: string[]): string =>
  process.platform === 'win32' ? `D:\\${segments.join('\\')}` : `/${segments.join('/')}`

/** absPath와 같은 경로를 홈 디렉터리 아래로 만든다 — 계정 판정처럼 홈 기준인 곳에서 쓴다 */
export const homePath = (home: string, ...segments: string[]): string => path.join(home, ...segments)
