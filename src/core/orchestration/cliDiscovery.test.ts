import { describe, it, expect } from 'vitest'
import { userDataDir } from './cliDiscovery'

const HOME = '/home/me'

describe('userDataDir', () => {
  it('win32 은 APPDATA 아래다', () => {
    expect(userDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, home: HOME }))
      .toBe('C:\\Users\\me\\AppData\\Roaming\\astera')
  })

  // APPDATA 가 없는 셸에서 도는 경우 — 없으면 못 찾는 것보다 규칙대로 만들어 보는 편이 낫다
  it('win32 에서 APPDATA 가 없으면 홈에서 만든다', () => {
    expect(userDataDir({ platform: 'win32', env: {}, home: 'C:/Users/me' }))
      .toBe('C:\\Users\\me\\AppData\\Roaming\\astera')
  })

  it('macOS 는 Application Support 아래다', () => {
    expect(userDataDir({ platform: 'darwin', env: {}, home: HOME }))
      .toBe('/home/me/Library/Application Support/astera')
  })

  it('linux 는 XDG_CONFIG_HOME, 없으면 ~/.config 다', () => {
    expect(userDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' }, home: HOME })).toBe('/cfg/astera')
    expect(userDataDir({ platform: 'linux', env: {}, home: HOME })).toBe('/home/me/.config/astera')
  })

  // 설치본과 개발본이 같은 파일을 두고 다투지 않게 하는 장치다(main/index.ts 가 붙인다)
  it('개발본은 -dev 가 붙는다', () => {
    expect(userDataDir({ platform: 'darwin', env: {}, home: HOME, dev: true }))
      .toBe('/home/me/Library/Application Support/astera-dev')
  })

  it('끝의 구분자는 두 번 겹치지 않는다', () => {
    expect(userDataDir({ platform: 'win32', env: { APPDATA: 'C:/x/' }, home: HOME })).toBe('C:\\x\\astera')
    expect(userDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg/' }, home: HOME })).toBe('/cfg/astera')
  })

  // 설정 화면과 오류 문구에 그대로 나가는 글이다 — 구분자가 섞인 경로는 고장난 것처럼 보인다
  it('win32 은 구분자를 섞지 않는다', () => {
    const dir = userDataDir({ platform: 'win32', env: { APPDATA: 'C:\\a\\b' }, home: HOME })
    expect(dir).not.toContain('/')
  })
})
