import { describe, it, expect } from 'vitest'
import { hostTarget, profilePath, userDataDir } from './discovery.js'
import { hostAddress } from './address.js'
import { HOST_PROTOCOL } from './protocol.js'

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

// Which Host this machine's tools talk to: the CLI's rule (src/cli/host.ts cliHostTarget), now the SDK's too.
describe('hostTarget', () => {
  const base = { platform: 'win32' as const, home: 'C:/Users/me', tmpDir: 'C:/Temp' }
  const ROAMING = { APPDATA: 'C:/Users/me/AppData/Roaming' }

  // Literal answers, not ones computed by the code under test (final review of SDK 1b, minor 10)
  it('reads the installed app profile, the dev one with ASTERA_PROFILE=dev, and ASTERA_PROFILE_DIR above both', () => {
    expect(hostTarget({ ...base, env: ROAMING }).profileDir).toBe('C:\\Users\\me\\AppData\\Roaming\\astera')
    expect(hostTarget({ ...base, env: { ...ROAMING, ASTERA_PROFILE: 'dev' } }).profileDir).toBe('C:\\Users\\me\\AppData\\Roaming\\astera-dev')
    expect(hostTarget({ ...base, env: { ...ROAMING, ASTERA_PROFILE: 'dev', ASTERA_PROFILE_DIR: 'D:/p/' } }).profileDir).toBe('D:\\p')
  })

  it('derives the address from the profile unless ASTERA_HOST names one', () => {
    const t = hostTarget({ ...base, env: { ASTERA_PROFILE_DIR: 'D:/p' } })
    expect(t.address).toMatch(/^\\\\\.\\pipe\\astera-host-[0-9a-f]{12}-v4$/)
    expect(t.address).toBe(hostAddress({ profileDir: 'D:\\p', platform: 'win32', tmpDir: base.tmpDir, protocol: HOST_PROTOCOL }).address)
    expect(hostTarget({ ...base, env: { ASTERA_PROFILE_DIR: 'D:/p', ASTERA_HOST: 'pipe-x' } }).address).toBe('pipe-x')
  })

  it('an empty variable counts as unset', () => {
    expect(hostTarget({ ...base, env: { ...ROAMING, ASTERA_PROFILE_DIR: '', ASTERA_HOST: '' } })).toEqual(hostTarget({ ...base, env: ROAMING }))
    expect(hostTarget({ ...base, env: { ...ROAMING, ASTERA_SANDBOX_HOST: '' } })).toEqual(hostTarget({ ...base, env: ROAMING }))
  })

  // Inside Claude's sandbox on macOS `$TMPDIR` is not the app's, so the address derived from it is not the socket the
  // sandbox lets the session reach; Astera names that socket in ASTERA_SANDBOX_HOST. A person's ASTERA_HOST still wins,
  // and the profile is never changed by either
  it('takes ASTERA_HOST first, then ASTERA_SANDBOX_HOST, then the derived address', () => {
    const mac = { platform: 'darwin' as const, home: '/Users/me', tmpDir: '/private/tmp/claude' }
    const derived = hostTarget({ ...mac, env: { ASTERA_PROFILE_DIR: '/Users/me/p' } })
    expect(derived.address).toMatch(/^\/private\/tmp\/claude\/astera-host-[0-9a-f]{12}-v\d+\/sock$/)
    const boxed = hostTarget({ ...mac, env: { ASTERA_PROFILE_DIR: '/Users/me/p', ASTERA_SANDBOX_HOST: '/var/f/T/astera-host-k-v4/sock' } })
    expect(boxed).toEqual({ address: '/var/f/T/astera-host-k-v4/sock', profileDir: '/Users/me/p' })
    const own = hostTarget({ ...mac, env: { ASTERA_PROFILE_DIR: '/Users/me/p', ASTERA_SANDBOX_HOST: '/var/f/T/astera-host-k-v4/sock', ASTERA_HOST: '/mine/sock' } })
    expect(own).toEqual({ address: '/mine/sock', profileDir: '/Users/me/p' })
  })
})

describe('profilePath', () => {
  it('writes the platform own separators and drops a trailing one, so the address hashes one spelling', () => {
    expect(profilePath('D:/p/', 'win32')).toBe(profilePath('D:\\p', 'win32'))
    expect(profilePath('/home/me/p/', 'linux')).toBe('/home/me/p')
    expect(profilePath('/', 'linux')).toBe('/')
  })

  it('keeps a root a root, a bare drive bare, and a posix backslash a file name character', () => {
    expect(profilePath('C:\\', 'win32')).toBe('C:\\')
    expect(profilePath('C:/', 'win32')).toBe('C:\\')
    expect(profilePath('C:', 'win32')).toBe('C:')
    expect(profilePath('//', 'linux')).toBe('/')
    expect(profilePath('/home/me/dir\\', 'linux')).toBe('/home/me/dir\\')
    expect(profilePath('/home/me/dir\\', 'darwin')).toBe('/home/me/dir\\')
  })
})
