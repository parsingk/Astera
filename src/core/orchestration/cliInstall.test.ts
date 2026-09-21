import { describe, it, expect } from 'vitest'
import { binDirFor, isOnPath, pathEntries, pathHintFor } from './cliInstall'

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
