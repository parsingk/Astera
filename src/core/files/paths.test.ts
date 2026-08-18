import { describe, it, expect } from 'vitest'
import { parentDir, resolveRelative, decodeUriPath } from './paths'

describe('parentDir', () => {
  it('마지막 구분자 앞까지 돌려준다 (역슬래시/슬래시 모두)', () => {
    expect(parentDir('D:\\a\\b\\c.ts')).toBe('D:\\a\\b')
    expect(parentDir('D:/a/b')).toBe('D:/a')
  })
  it('구분자가 없으면 원본 반환', () => {
    expect(parentDir('x')).toBe('x')
  })
})

describe('resolveRelative', () => {
  it('같은 폴더의 파일', () => {
    expect(resolveRelative('C:/p/README.md', 'a.png')).toBe('C:/p/a.png')
    expect(resolveRelative('C:/p/README.md', './a.png')).toBe('C:/p/a.png')
  })
  it('하위 폴더', () => {
    expect(resolveRelative('C:/p/README.md', 'assets/a.png')).toBe('C:/p/assets/a.png')
    expect(resolveRelative('C:/p/docs/x.md', './img/a.png')).toBe('C:/p/docs/img/a.png')
  })
  it('상위로 올라간다', () => {
    expect(resolveRelative('C:/p/docs/x.md', '../a.png')).toBe('C:/p/a.png')
    expect(resolveRelative('C:/p/docs/deep/x.md', '../../a.png')).toBe('C:/p/a.png')
  })
  // 이 함수가 실제로 보장하는 것은 "첫 조각 아래로는 줄지 않는다"이다. win32 드라이브 경로에서는
  // 첫 조각이 드라이브 문자라 결과적으로 드라이브 루트에서 멈추지만, POSIX 절대경로의 첫 조각은
  // 선행 '/' 앞의 빈 문자열이다 — 그 자체가 파일시스템 루트일 뿐, 문서의 하위 트리를 벗어나지
  // 못하게 막아주지는 않는다. 이 앱은 리눅스에서도 돈다. 실제 허용 루트 검사는
  // files.readDataUrl(메인 프로세스)가 한다 — 여기서는 그 사실을 감추지 않고 고정해 둔다.
  it('첫 조각 아래로는 줄어들지 않는다 (POSIX 에서는 파일시스템 루트일 뿐, 문서 트리 밖으로 벗어나는 것을 막지 않는다)', () => {
    expect(resolveRelative('C:/x.md', '../../../a.png')).toBe('C:/a.png')
    expect(resolveRelative('/home/u/p/x.md', '../../../../../../etc/passwd')).toBe('/etc/passwd')
    expect(resolveRelative('/a/b.md', '../c.png')).toBe('/c.png')
  })
  // Windows 경로가 섞여 온다 — 탐색기는 백슬래시를, 마크다운은 슬래시를 쓴다
  it('구분자가 섞여도 원래 구분자를 지킨다', () => {
    expect(resolveRelative('C:\\p\\README.md', 'assets/a.png')).toBe('C:\\p\\assets\\a.png')
    expect(resolveRelative('C:\\p\\docs\\x.md', '../a.png')).toBe('C:\\p\\a.png')
  })
  it('중간의 . 을 지운다', () => {
    expect(resolveRelative('C:/p/x.md', './a/./b.png')).toBe('C:/p/a/b.png')
  })
  it('빈 상대경로는 문서가 있는 폴더', () => {
    expect(resolveRelative('C:/p/x.md', '')).toBe('C:/p')
  })
})

describe('decodeUriPath', () => {
  it('%XX 이스케이프를 푼다', () => {
    expect(decodeUriPath('assets/my%20file.png')).toBe('assets/my file.png')
  })
  it('이스케이프가 없으면 그대로', () => {
    expect(decodeUriPath('plain.png')).toBe('plain.png')
  })
  it('망가진 이스케이프는 원본을 그대로 돌려준다 (decodeURIComponent 는 여기서 던진다)', () => {
    expect(decodeUriPath('a%zzb')).toBe('a%zzb')
    expect(decodeUriPath('lone%')).toBe('lone%')
  })
})
