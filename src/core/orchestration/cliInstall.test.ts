import { describe, it, expect } from 'vitest'
import { appImageLaunchFor, binDirFor, isOnPath, pathEntries, pathHintFor, userPathFits, userPathWith, userPathWithout } from './cliInstall'

const HOME = '/home/me'

describe('binDirFor', () => {
  it('win32 은 LOCALAPPDATA 아래다', () => {
    expect(binDirFor({ platform: 'win32', env: { LOCALAPPDATA: 'C:/Users/me/AppData/Local' }, home: HOME }))
      .toBe('C:\\Users\\me\\AppData\\Local\\astera\\bin')
  })

  it('win32 에서 LOCALAPPDATA 가 없으면 홈에서 만든다', () => {
    expect(binDirFor({ platform: 'win32', env: {}, home: 'C:/Users/me' }))
      .toBe('C:\\Users\\me\\AppData\\Local\\astera\\bin')
  })

  // systemd 와 대부분의 배포판이 이미 PATH 에 넣어 두는 자리 — 안내 없이 바로 되는 경우가 가장 많다
  it('나머지는 ~/.local/bin 이다', () => {
    expect(binDirFor({ platform: 'darwin', env: {}, home: HOME })).toBe('/home/me/.local/bin')
    expect(binDirFor({ platform: 'linux', env: {}, home: HOME })).toBe('/home/me/.local/bin')
  })

  it('끝의 구분자는 두 번 겹치지 않는다', () => {
    const want = 'C:\\x\\astera\\bin'
    expect(binDirFor({ platform: 'win32', env: { LOCALAPPDATA: 'C:/x/' }, home: HOME })).toBe(want)
    expect(binDirFor({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\x\\' }, home: HOME })).toBe(want)
  })
})

describe('pathEntries', () => {
  it('플랫폼의 구분자로 가른다', () => {
    expect(pathEntries({ pathVar: 'C:/a;C:/b', platform: 'win32' })).toEqual(['C:/a', 'C:/b'])
    expect(pathEntries({ pathVar: '/a:/b', platform: 'linux' })).toEqual(['/a', '/b'])
  })

  // win32 의 PATH 에는 공백이 든 경로가 따옴표째 들어 있는 경우가 있다
  it('빈 항목과 따옴표를 걷는다', () => {
    expect(pathEntries({ pathVar: 'C:/a;;"C:/Program Files/x"; ', platform: 'win32' }))
      .toEqual(['C:/a', 'C:/Program Files/x'])
  })
})

describe('isOnPath', () => {
  // win32 은 대소문자를 가리지 않고 구분자도 섞여 들어온다
  it('철자가 달라도 같은 자리로 본다', () => {
    expect(
      isOnPath({
        dir: 'C:\\Users\\me\\AppData\\Local\\astera\\bin',
        pathVar: 'C:/other;c:\\users\\me\\appdata\\local\\astera\\bin',
        platform: 'win32'
      })
    ).toBe(true)
  })

  it('없으면 없다고 한다', () => {
    expect(isOnPath({ dir: '/home/me/.local/bin', pathVar: '/usr/bin:/bin', platform: 'linux' }))
      .toBe(false)
  })

  // 형제 접두사에 걸리면 안 된다 — .local/bin2 는 .local/bin 이 아니다
  it('접두사가 같은 이웃을 같은 것으로 보지 않는다', () => {
    expect(isOnPath({ dir: '/home/me/.local/bin', pathVar: '/home/me/.local/bin2', platform: 'linux' }))
      .toBe(false)
  })
})

describe('pathHintFor', () => {
  // **setx 를 주지 않는다** — 값이 1024자를 넘으면 사람의 PATH 를 조용히 자른다
  it('win32 은 사용자 범위 Path 만 읽어 덧붙인다', () => {
    const hint = pathHintFor({ dir: 'C:/x/bin', platform: 'win32' })
    expect(hint).toContain("GetEnvironmentVariable('Path', 'User')")
    expect(hint).toContain('C:/x/bin')
    expect(hint).not.toContain('setx')
  })

  it('나머지는 export 한 줄이다', () => {
    expect(pathHintFor({ dir: '/home/me/.local/bin', platform: 'linux' }))
      .toBe('export PATH="$PATH:/home/me/.local/bin"')
  })
})

// AppImage 로 돌 때 process.execPath 는 /tmp/.mount_* 라는 임시 마운트다. 앱을 끄면 사라지고 다음
// 실행은 다른 이름으로 마운트된다. 공개 셔틀은 진짜 파일인 $APPIMAGE 를 불러야 한다.
describe('appImageLaunchFor', () => {
  const execPath = '/tmp/.mount_AsteraAbc/astera'
  const entryPath = '/tmp/.mount_AsteraAbc/resources/app.asar/out/main/cli.js'

  it('APPIMAGE 가 있으면 그 파일과 마운트 안의 엔트리 상대 경로를 준다', () => {
    expect(
      appImageLaunchFor({
        env: { APPIMAGE: '/home/me/Apps/Astera.AppImage', APPDIR: '/tmp/.mount_AsteraAbc' },
        execPath,
        entryPath
      })
    ).toEqual({ path: '/home/me/Apps/Astera.AppImage', entryInMount: 'resources/app.asar/out/main/cli.js' })
  })

  it('APPDIR 이 없으면 실행 파일이 있는 폴더를 마운트로 본다', () => {
    expect(appImageLaunchFor({ env: { APPIMAGE: '/a/Astera.AppImage' }, execPath, entryPath })).toEqual({
      path: '/a/Astera.AppImage',
      entryInMount: 'resources/app.asar/out/main/cli.js'
    })
  })

  it('APPIMAGE 가 없으면 AppImage 가 아니다', () => {
    expect(appImageLaunchFor({ env: {}, execPath: '/opt/Astera/astera', entryPath: '/opt/Astera/cli.js' }))
      .toBeUndefined()
    expect(appImageLaunchFor({ env: { APPIMAGE: '' }, execPath, entryPath })).toBeUndefined()
  })

  // 마운트 밖의 엔트리는 원래 오래 사는 경로다. 거기에 AppImage 실행을 끼울 이유가 없다.
  it('엔트리가 마운트 밖이면 AppImage 실행을 쓰지 않는다', () => {
    expect(
      appImageLaunchFor({
        env: { APPIMAGE: '/a/Astera.AppImage', APPDIR: '/tmp/.mount_AsteraAbc' },
        execPath,
        entryPath: '/tmp/.mount_AsteraAbcd/cli.js'
      })
    ).toBeUndefined()
  })
})

// The Install button on Windows puts the folder on the user's Path itself, with the person's consent
// (the checkbox beside it), and Uninstall takes that one entry out again. The value read and written is
// the registry's raw one, so an entry that names a variable (%LOCALAPPDATA%\...) is compared expanded.
describe('userPathWith / userPathWithout (win32 user Path)', () => {
  const dir = 'C:\\Users\\me\\AppData\\Local\\astera\\bin'
  const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } as NodeJS.ProcessEnv

  it('appends the folder, keeping everything already there as it was', () => {
    expect(userPathWith('C:\\tools;%USERPROFILE%\\bin', dir, env)).toBe(`C:\\tools;%USERPROFILE%\\bin;${dir}`)
    // A Path that ends in a separator keeps ending in one, so Uninstall gives back the very same value
    expect(userPathWith('C:\\tools;', dir, env)).toBe(`C:\\tools;${dir};`)
    expect(userPathWith('', dir, env)).toBe(dir)
  })

  // Measured on this machine's real Path (2026-09-30): it ended in ';', Install dropped that, and
  // Uninstall gave back a value one character short of the one it found.
  it('Install then Uninstall gives back exactly the value it found', () => {
    for (const v of ['', 'C:\\tools', 'C:\\tools;', 'C:\\tools;;', ';C:\\tools', '%USERPROFILE%\\bin;D:\\a b;'])
      expect(userPathWithout(userPathWith(v, dir, env)!, dir, env), JSON.stringify(v)).toBe(v)
  })

  it('adds nothing when the folder is already there, however it is spelled', () => {
    for (const v of [`C:\\tools;${dir}`, `C:\\tools;${dir.toUpperCase()}\\`, 'C:\\tools;%LOCALAPPDATA%\\astera\\bin', `"${dir}"`])
      expect(userPathWith(v, dir, env), v).toBeNull()
  })

  it('takes out only the folder, and leaves every other entry, empty ones included, alone', () => {
    expect(userPathWithout(`C:\\tools;${dir};%USERPROFILE%\\bin`, dir, env)).toBe('C:\\tools;%USERPROFILE%\\bin')
    expect(userPathWithout('C:\\tools;;%LOCALAPPDATA%\\astera\\bin', dir, env)).toBe('C:\\tools;')
    expect(userPathWithout('C:\\tools', dir, env)).toBeNull()
  })
})

// Measured on Windows 11 (2026-10-01) through a cmd that Explorer itself started: with a system Path
// of 1629 characters expanded, ending in ';', a user Path of 2465 characters reached the new shell and
// one of 2466 did not reach it at all, every entry of it gone. A REG_EXPAND_SZ user Path counted its
// expanded length. With the same system Path's trailing ';' taken off (1628), the boundary stayed at
// 2465 / 2466: Windows puts a ';' between them.
describe('userPathFits (win32: whether Explorer hands the user Path to new shells)', () => {
  const machine = `C:\\WINDOWS\\system32;${'m'.repeat(1629 - 21)};`
  const env = { USERPROFILE: 'C:\\Users\\anipen' } as NodeJS.ProcessEnv

  it('holds the measured boundary', () => {
    expect(machine.length).toBe(1629)
    expect(userPathFits({ machine, user: 'u'.repeat(2465), env })).toBe(true)
    expect(userPathFits({ machine, user: 'u'.repeat(2466), env })).toBe(false)
  })

  it('counts both values expanded', () => {
    // 13 characters raw, 15 expanded: 2460 raw fits, its 2464 expanded too; 2464 raw is 2468 expanded
    expect(userPathFits({ machine, user: '%USERPROFILE%;%USERPROFILE%' + 'u'.repeat(2460 - 27), env })).toBe(true)
    expect(userPathFits({ machine, user: '%USERPROFILE%;%USERPROFILE%' + 'u'.repeat(2464 - 27), env })).toBe(false)
    expect(userPathFits({ machine: `%USERPROFILE%${machine.slice(13)}`, user: 'u'.repeat(2464), env })).toBe(false)
  })

  it('counts the separator Windows puts between them when the system Path does not end in one', () => {
    expect(userPathFits({ machine: machine.slice(0, -1), user: 'u'.repeat(2465), env })).toBe(true)
    expect(userPathFits({ machine: machine.slice(0, -1) + 'm', user: 'u'.repeat(2465), env })).toBe(false)
  })
})

