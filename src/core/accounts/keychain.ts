// macOS Keychain에 든 Claude Code 자격증명 조회.
//
// **왜 필요한가:** macOS의 Claude Code는 OAuth 자격증명을 configDir의 .credentials.json이 아니라
// login 키체인에 넣는다. 파일 존재만 보는 판정은 macOS에서 항상 "로그아웃"이 되고, 그러면
// defaultAccountIdOf(accounts/defaultAccount.ts)와 resumeAccountOptions(resume.ts)가 후보를 못
// 골라 롤링과 이어하기가 통째로 죽는다.
//
// **서비스명 규칙(측정):** 설치된 claude 2.1.224 바이너리에서 읽어낸 형태는
//   `Claude Code${OAUTH_FILE_SUFFIX}-credentials${suffix}`
// - OAUTH_FILE_SUFFIX 는 정식 릴리스에서 빈 문자열이다 (실제 키체인 항목이 정확히
//   "Claude Code-credentials" 인 것으로 확인).
// - suffix 는 CLAUDE_CONFIG_DIR 가 없으면 '', 있으면 `-${sha256(configDir.normalize('NFC')).hex[0..8]}`.
// - CLAUDE_SECURESTORAGE_CONFIG_DIR 라는 오버라이드 환경변수도 있으나 이 앱은 설정하지 않으므로
//   여기서는 다루지 않는다.
// - account 는 $USER (없으면 os.userInfo().username), /^[a-zA-Z0-9._-]+$/ 를 통과하지 못하면
//   'claude-code-user'.
//
// 문서화된 계약이 아니라 한 버전에서 관찰한 규칙이다. 값이 바뀌면 판정은 "로그아웃"으로 조용히
// 틀어진다 — 그래서 claudeLoginProbe 는 파일 마커를 **먼저** 보고, 키체인은 그 다음에만 묻는다.
import { createHash } from 'node:crypto'
import path from 'node:path'

const SERVICE_BASE = 'Claude Code-credentials'

/** claude가 account 필드에 넣는 사용자명 규칙 */
const VALID_ACCOUNT = /^[a-zA-Z0-9._-]+$/

export function keychainAccount(env: { USER?: string }, fallbackUser: string): string {
  const name = env.USER || fallbackUser
  return VALID_ACCOUNT.test(name) ? name : 'claude-code-user'
}

const digest = (dir: string): string =>
  createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)

/**
 * 이 configDir에 대응하는 Keychain 서비스명 후보들.
 *
 * configDir 이 null 이면 "CLAUDE_CONFIG_DIR 를 설정하지 않는 기본 계정"이라는 뜻이고, 접미사 없는
 * 이름 하나만 나온다.
 *
 * 격리 계정에서 **후보가 여럿인 이유**: 해시 입력이 환경변수 원문인지 정규화된 절대경로인지가
 * 확정되지 않았다. 둘 다 시도하는 비용은 security 호출 한 번이고, 틀리면 로그인이 안 된 것처럼
 * 보이는 대가가 훨씬 크다.
 */
export function claudeKeychainServices(configDir: string | null): string[] {
  if (configDir === null) return [SERVICE_BASE]
  const seen = new Set<string>()
  for (const variant of [configDir, path.resolve(configDir)]) {
    seen.add(`${SERVICE_BASE}-${digest(variant)}`)
  }
  return [...seen]
}

export type KeychainHas = (service: string, account: string) => Promise<boolean>

/**
 * security(1) 로 항목 존재만 확인한다.
 *
 * **-w 를 주지 않는 것이 핵심이다.** -w 는 비밀번호 본문을 읽으므로 이 앱에 대한 키체인 접근 승인
 * 대화상자가 뜬다. 존재 확인만 하는 지금 형태는 ACL을 건드리지 않아 조용히 끝난다.
 */
export function makeSecurityKeychainHas(
  run: (file: string, args: string[]) => Promise<number>
): KeychainHas {
  return async (service, account) => {
    try {
      return (await run('security', ['find-generic-password', '-a', account, '-s', service])) === 0
    } catch {
      return false
    }
  }
}
