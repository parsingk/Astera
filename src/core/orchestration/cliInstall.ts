// `astera` 를 보통 셸에서 부를 수 있게 만드는 일 (공개 CLI 설계 §10).
//
// **새로 만드는 것은 자리뿐이다.** 셔틀 파일은 앱이 이미 쓰고 있고(core/orchestration/exec/shuttle.ts),
// 그것을 세션의 PATH 에 넣어 준다. 공개한다는 것은 그 두 파일을 사람의 PATH 에서도 닿는 곳에
// 한 벌 더 쓰는 일이다.
//
// **순수하다** — 플랫폼과 환경변수가 인자로 들어온다. cliDiscovery.ts 와 같은 이유다: 세 운영체제
// 에서 다 맞아야 하는데 테스트는 한 대에서만 돈다.
import path from 'node:path'
import { isSamePath } from '../files/tree'
import { nativePath } from './cliDiscovery'
import type { AppImageLaunch } from './exec/shuttle'

/**
 * 셔틀을 둘 자리.
 *
 * **앱의 userData 가 아니다.** 그쪽은 앱이 자기 살림을 두는 곳이고, 사람이 PATH 에 넣을 만한
 * 자리가 아니다 — 프로필마다 갈리고(`astera-dev`), 경로에 앱 이름이 두 번 들어간다.
 *
 * win32 은 `%LOCALAPPDATA%/astera/bin`, 나머지는 `~/.local/bin` 이다. 뒤쪽은 XDG 가 정한 자리는
 * 아니지만 systemd 와 대부분의 배포판이 이미 PATH 에 넣어 두는 자리이고, 그래서 안내 없이 바로
 * 되는 경우가 가장 많다.
 */
export function binDirFor(a: {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
}): string {
  if (a.platform === 'win32') {
    const local = a.env.LOCALAPPDATA ?? `${a.home}/AppData/Local`
    // 설정 화면이 이 경로를 그대로 보여 주고, PATH 안내문에도 그대로 들어간다.
    return nativePath(`${local.replace(/[\\/]+$/, '')}/astera/bin`, 'win32')
  }
  return `${a.home}/.local/bin`
}

/** PATH 를 항목으로 가른다. 빈 항목과 따옴표를 걷는다 — win32 의 PATH 에는 공백이 든 경로가
 *  따옴표째 들어 있는 경우가 있다. */
export function pathEntries(a: { pathVar: string; platform: NodeJS.Platform }): string[] {
  return a.pathVar
    .split(a.platform === 'win32' ? ';' : ':')
    .map((e) => e.trim().replace(/^"|"$/g, ''))
    .filter((e) => e.length > 0)
}

/** 그 자리가 이미 PATH 에 있는가. 비교는 isSamePath 다 — win32 은 대소문자를 가리지 않고
 *  구분자도 섞여 들어온다(`C:\x` 와 `C:/x/`). */
export function isOnPath(a: {
  dir: string
  pathVar: string
  platform: NodeJS.Platform
}): boolean {
  return pathEntries(a).some((e) => isSamePath(e, a.dir, a.platform))
}

/**
 * PATH 에 없을 때 사람에게 건네는 한 줄.
 *
 * **셸 프로필을 고치지 않는다**(명세 §29, 설계 §10). 사람이 쓰지 않은 파일은 무언가 망가졌을 때
 * 들여다볼 생각을 하지 않는 파일이다.
 *
 * win32 은 `setx` 를 주지 않는다 — `setx PATH "%PATH%;…"` 는 널리 쓰이지만 값이 1024자를 넘으면
 * **잘라 버린다.** 사람의 PATH 를 조용히 자르는 명령을 안내문으로 내밀 수는 없다. 대신 사용자
 * 범위의 Path 만 읽어서 덧붙이는 PowerShell 한 줄을 준다.
 */
export function pathHintFor(a: { dir: string; platform: NodeJS.Platform }): string {
  if (a.platform === 'win32')
    return `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${a.dir}', 'User')`
  return `export PATH="$PATH:${a.dir}"`
}

/**
 * 공개 셔틀이 AppImage 를 거쳐 앱을 불러야 하는가, 그렇다면 무엇을 부르는가 (명세 §29).
 *
 * AppImage 로 돌 때 `process.execPath` 는 `/tmp/.mount_*` 아래의 임시 마운트다. 앱을 끄면 사라지고
 * 다음 실행은 다른 이름으로 마운트된다. 그 경로를 셔틀에 적으면 앱을 끄는 순간 `astera` 가 죽는다.
 * AppImage 런타임은 진짜 파일을 `APPIMAGE` 로, 마운트를 `APPDIR` 로 알려 준다. 셔틀은 앞의 것을
 * 부르고, 엔트리는 마운트 안의 상대 경로로 들고 가서 그 실행의 `APPDIR` 에 붙인다.
 *
 * `APPDIR` 이 없으면 실행 파일이 있는 폴더를 마운트로 본다. electron-builder 는 실행 파일을 이미지의
 * 뿌리에 둔다. 엔트리가 마운트 밖에 있으면 undefined 다: 그 경로는 원래 오래 산다.
 */
export function appImageLaunchFor(a: {
  env: NodeJS.ProcessEnv
  execPath: string
  entryPath: string
}): AppImageLaunch | undefined {
  const appImage = a.env.APPIMAGE
  if (!appImage) return undefined
  const mount = (a.env.APPDIR || path.posix.dirname(a.execPath)).replace(/\/+$/, '')
  if (!a.entryPath.startsWith(`${mount}/`)) return undefined
  return { path: appImage, entryInMount: a.entryPath.slice(mount.length + 1) }
}
