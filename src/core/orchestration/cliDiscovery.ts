// 세션 밖에서 실행된 `astera` 가 앱을 찾는 법 (공개 CLI 설계 §4).
//
// **순수하다** — 플랫폼과 환경변수가 인자로 들어온다. 이 판정은 세 운영체제에서 다 맞아야 하는데
// 테스트는 한 대에서만 돌기 때문이고, `core/host/address.ts` 가 같은 이유로 같은 모양이다.

/** 앱이 접속 정보를 적어 두는 파일의 이름. `writeInfo`(main/orchestration/shuttle.ts)가 쓰고
 *  앱이 종료하며 지운다 — 그래서 "앱이 없다" 가 곧 "이 파일이 없다" 다. */
export const INFO_FILE = 'orch-info.json'

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
    return `${appData.replace(/[\\/]+$/, '')}/${name}`
  }
  if (a.platform === 'darwin') return `${a.home}/Library/Application Support/${name}`
  const xdg = a.env.XDG_CONFIG_HOME
  return `${(xdg && xdg.length > 0 ? xdg : `${a.home}/.config`).replace(/[\\/]+$/, '')}/${name}`
}

/**
 * 이 실행이 읽어야 할 접속 정보 파일.
 *
 * **`ASTERA_INFO` 가 언제나 이긴다.** 그 변수가 있다는 것은 앱이 띄운 세션 안이라는 뜻이고, 그
 * 세션은 자기를 띄운 앱과 말해야 한다 — 설치본이 함께 떠 있다고 해서 그쪽으로 새면 안 된다.
 *
 * 없으면 설치본을 본다. `ASTERA_PROFILE=dev` 면 개발본이다 — 둘 다 떠 있을 때 사람이 무엇을
 * 뜻하는지에 대한 판단이고, 설계 §15 에 열어 둔 채로 적혀 있다.
 */
export function infoPathFor(a: {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
}): string {
  const explicit = a.env.ASTERA_INFO
  if (explicit !== undefined && explicit.length > 0) return explicit
  const dir = userDataDir({
    platform: a.platform,
    env: a.env,
    home: a.home,
    dev: a.env.ASTERA_PROFILE === 'dev'
  })
  return `${dir}/orch/${INFO_FILE}`
}
