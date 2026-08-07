// 계정 로그인 판정 프로브.
//
// 프로바이더마다 근거가 다르고(claude=.credentials.json 또는 macOS Keychain, codex=auth.json),
// claude 는 플랫폼에 따라 또 갈린다. 그 갈래를 ProviderDescriptor 에서 걷어내 여기 모은다.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { claudeKeychainServices, type KeychainHas } from './keychain'

/** configDir 하나를 받아 로그인 여부를 답한다. 절대 던지지 않는다. */
export type LoginProbe = (configDir: string) => Promise<boolean>

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** configDir 안의 마커 파일 존재로 판정한다 (codex, 그리고 win32의 claude). */
export function fileMarkerProbe(marker: string): LoginProbe {
  return (configDir) => exists(path.join(configDir, marker))
}

/**
 * claude 판정.
 *
 * 순서가 중요하다 — **파일이 먼저, Keychain이 나중**이다. 파일이 있으면 그것으로 확정하고 키체인은
 * 묻지도 않는다. 이유 두 가지: (1) 구버전 claude와 CLAUDE_CODE 관련 설정으로 파일에 쓰는 환경이
 * 여전히 존재하고, (2) 키체인 서비스명 규칙은 문서화된 계약이 아니라 한 버전에서 관찰한 것이라
 * 언젠가 어긋난다. 어긋나도 파일 경로가 살아 있으면 판정이 통째로 죽지는 않는다.
 */
export function claudeLoginProbe(opts: {
  platform: NodeJS.Platform
  homeDir: string
  account: string
  keychainHas: KeychainHas
}): LoginProbe {
  const fileProbe = fileMarkerProbe('.credentials.json')
  return async (configDir) => {
    if (await fileProbe(configDir)) return true
    if (opts.platform !== 'darwin') return false
    // 홈 기본 디렉터리(~/.claude)로 도는 세션은 CLAUDE_CONFIG_DIR 를 설정하지 않는다
    // (sessions/manager.ts:154 의 isAmbientDir 규칙). 그러면 키체인 항목에도 접미사가 없다.
    const ambient = path.resolve(configDir) === path.resolve(path.join(opts.homeDir, '.claude'))
    const services = claudeKeychainServices(ambient ? null : configDir)
    for (const service of services) {
      try {
        if (await opts.keychainHas(service, opts.account)) return true
      } catch {
        return false // security 자체가 없거나 죽었다 — 로그아웃으로 본다
      }
    }
    return false
  }
}
