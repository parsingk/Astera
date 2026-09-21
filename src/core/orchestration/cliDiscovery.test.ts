import { describe, it, expect } from 'vitest'
import { infoPathFor, userDataDir } from './cliDiscovery'

const HOME = '/home/me'

describe('userDataDir', () => {
  it('win32 은 APPDATA 아래다', () => {
    expect(userDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, home: HOME }))
      .toBe('C:\\Users\\me\\AppData\\Roaming/astera')
  })

  // APPDATA 가 없는 셸에서 도는 경우 — 없으면 못 찾는 것보다 규칙대로 만들어 보는 편이 낫다
  it('win32 에서 APPDATA 가 없으면 홈에서 만든다', () => {
    expect(userDataDir({ platform: 'win32', env: {}, home: 'C:/Users/me' }))
      .toBe('C:/Users/me/AppData/Roaming/astera')
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
    expect(userDataDir({ platform: 'win32', env: { APPDATA: 'C:/x/' }, home: HOME })).toBe('C:/x/astera')
    expect(userDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg/' }, home: HOME })).toBe('/cfg/astera')
  })
})

describe('infoPathFor', () => {
  // **세션 안에서는 그 세션을 띄운 앱과 말해야 한다.** 설치본이 함께 떠 있다고 그쪽으로 새면,
  // 워커의 보고가 자기를 띄우지 않은 앱에 들어간다.
  it('ASTERA_INFO 가 있으면 언제나 그것이다', () => {
    expect(infoPathFor({ platform: 'win32', env: { ASTERA_INFO: 'D:/x/info.json', APPDATA: 'C:/a' }, home: HOME }))
      .toBe('D:/x/info.json')
  })

  it('빈 ASTERA_INFO 는 없는 것으로 본다', () => {
    expect(infoPathFor({ platform: 'linux', env: { ASTERA_INFO: '' }, home: HOME }))
      .toBe('/home/me/.config/astera/orch/orch-info.json')
  })

  it('없으면 설치본의 것을 본다', () => {
    expect(infoPathFor({ platform: 'darwin', env: {}, home: HOME }))
      .toBe('/home/me/Library/Application Support/astera/orch/orch-info.json')
  })

  it('ASTERA_PROFILE=dev 면 개발본이다', () => {
    expect(infoPathFor({ platform: 'darwin', env: { ASTERA_PROFILE: 'dev' }, home: HOME }))
      .toBe('/home/me/Library/Application Support/astera-dev/orch/orch-info.json')
  })
})
