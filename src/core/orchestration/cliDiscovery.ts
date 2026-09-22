// 세션 밖에서 실행된 `astera` 가 프로필 폴더를 찾는 법 (공개 CLI 설계 §4).
//
// **접속 정보 파일은 없어졌다.** 예전에는 이 파일이 `orch-info.json` 의 경로도 지었다 — 이제
// CLI 는 여기서 나온 프로필 폴더 하나로 Host 주소와 보고 큐를 둘 다 짓는다
// (`cliHostTarget`, src/cli/host.ts; 호스트 제어 평면 설계 §7).
//
// **순수하다** — 플랫폼과 환경변수가 인자로 들어온다. 이 판정은 세 운영체제에서 다 맞아야 하는데
// 테스트는 한 대에서만 돌기 때문이고, `core/host/address.ts` 가 같은 이유로 같은 모양이다.

/**
 * 그 플랫폼이 쓰는 구분자 하나로 맞춘다.
 *
 * **섞여 있어도 동작은 한다**(Windows API 는 둘 다 받는다). 맞추는 이유는 사람이다 — 이 경로들은
 * 설정 화면과 오류 문구에 그대로 나가고, 구분자가 섞인 경로는 고장난 것처럼 보인다. 복사해
 * 붙여 넣을 글이면 더 그렇다.
 */
export const nativePath = (p: string, platform: NodeJS.Platform): string =>
  platform === 'win32' ? p.replace(/\//g, '\\') : p

/**
 * Electron 의 `app.getPath('userData')` 가 가리키는 곳을 CLI 쪽에서 다시 만든다.
 *
 * **같은 값을 두 곳에서 만드는 것이 맞는가.** 앱은 Electron 에게 묻고 CLI 는 Electron 없이 도므로
 * (ELECTRON_RUN_AS_NODE) 묻는 길이 없다. 그래서 규칙을 옮겨 적되, 규칙 자체는 Electron 의 것을
 * 그대로 따른다 — appData 아래 앱 이름 하나.
 *
 * `-dev` 접미사는 이 저장소의 것이다(`src/main/index.ts` 가 패키징되지 않았을 때 붙인다). 설치본과
 * 개발본이 같은 파일을 두고 다투지 않게 하는 장치이고, CLI 도 그래서 둘을 가려야 한다.
 */
export function userDataDir(a: {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
  /** 개발본을 가리키게 한다. `ASTERA_PROFILE=dev` 가 이것을 켠다. */
  dev?: boolean
}): string {
  const name = a.dev === true ? 'astera-dev' : 'astera'
  if (a.platform === 'win32') {
    const appData = a.env.APPDATA ?? `${a.home}/AppData/Roaming`
    return nativePath(`${appData.replace(/[\\/]+$/, '')}/${name}`, 'win32')
  }
  if (a.platform === 'darwin') return `${a.home}/Library/Application Support/${name}`
  const xdg = a.env.XDG_CONFIG_HOME
  return `${(xdg && xdg.length > 0 ? xdg : `${a.home}/.config`).replace(/[\\/]+$/, '')}/${name}`
}
