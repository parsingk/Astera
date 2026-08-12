import { describe, it, expect } from 'vitest'
import { foldStatus, parsePorcelainZ, folderCounts } from './status'

describe('foldStatus', () => {
  it('unmerged 7종은 모두 conflict', () => {
    for (const xy of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
      expect(foldStatus(xy)).toBe('conflict')
    }
  })

  it('삭제가 새 파일·수정보다 우선한다 — AD는 deleted', () => {
    expect(foldStatus('AD')).toBe('deleted') // 스테이지 추가 후 작업트리에서 삭제
    expect(foldStatus('D ')).toBe('deleted')
    expect(foldStatus(' D')).toBe('deleted')
  })

  it('untracked와 staged add는 new', () => {
    expect(foldStatus('??')).toBe('new')
    expect(foldStatus('A ')).toBe('new')
    expect(foldStatus('AM')).toBe('new') // 추가 후 또 고쳤어도 여전히 새 파일
  })

  it('수정·rename·typechange는 modified', () => {
    expect(foldStatus('M ')).toBe('modified')
    expect(foldStatus(' M')).toBe('modified')
    expect(foldStatus('MM')).toBe('modified')
    expect(foldStatus('R ')).toBe('modified')
    expect(foldStatus('T ')).toBe('modified')
  })
})

describe('parsePorcelainZ', () => {
  it('빈 출력은 빈 배열', () => {
    expect(parsePorcelainZ('')).toEqual([])
  })

  it('레코드 끝의 NUL이 남긴 빈 꼬리 필드를 무시한다', () => {
    expect(parsePorcelainZ('?? a.ts\0')).toEqual([{ relPath: 'a.ts', state: 'new' }])
  })

  it('선행 공백이 살아 있는 레코드의 경로를 온전히 돌려준다', () => {
    // trim 없이 받아야만 이 입력이 온다 — git()에 trim:false를 준 이유
    expect(parsePorcelainZ(' M src/foo.ts\0')).toEqual([
      { relPath: 'src/foo.ts', state: 'modified' }
    ])
  })

  it('구분 공백이 없는 깨진 레코드는 버린다 (추측 복구 금지)', () => {
    // ' M src/foo.ts'가 trim된 모습. slice(3)으로 떼면 경로가 'rc/foo.ts'가 되므로
    // 잘못된 경로에 상태를 칠하느니 그 레코드를 버린다.
    expect(parsePorcelainZ('M src/foo.ts\0')).toEqual([])
  })

  it('rename은 원본 경로 필드를 소비해 다음 레코드를 오독하지 않는다', () => {
    const out = parsePorcelainZ('R  new/a.ts\0old/a.ts\0?? b.ts\0')
    expect(out).toEqual([
      { relPath: 'new/a.ts', state: 'modified' },
      { relPath: 'b.ts', state: 'new' }
    ])
  })

  it('copy도 원본 경로 필드를 소비한다', () => {
    const out = parsePorcelainZ('C  new/a.ts\0old/a.ts\0 M c.ts\0')
    expect(out).toEqual([
      { relPath: 'new/a.ts', state: 'modified' },
      { relPath: 'c.ts', state: 'modified' }
    ])
  })

  it('여러 레코드를 순서대로 파싱한다', () => {
    const out = parsePorcelainZ('?? a.ts\0 M b.ts\0UU c.ts\0 D d.ts\0')
    expect(out).toEqual([
      { relPath: 'a.ts', state: 'new' },
      { relPath: 'b.ts', state: 'modified' },
      { relPath: 'c.ts', state: 'conflict' },
      { relPath: 'd.ts', state: 'deleted' }
    ])
  })

  it('공백이 든 경로를 자르지 않는다', () => {
    expect(parsePorcelainZ('?? my docs/a b.md\0')).toEqual([
      { relPath: 'my docs/a b.md', state: 'new' }
    ])
  })
})

describe('folderCounts', () => {
  it('조상 폴더마다 1씩 누적한다 (win32 구분자)', () => {
    const counts = folderCounts(
      ['D:\\proj\\src\\core\\a.ts', 'D:\\proj\\src\\core\\b.ts', 'D:\\proj\\docs\\c.md'],
      'D:\\proj'
    )
    expect(counts['D:\\proj\\src\\core']).toBe(2)
    expect(counts['D:\\proj\\src']).toBe(2)
    expect(counts['D:\\proj\\docs']).toBe(1)
    expect(counts['D:\\proj']).toBe(3)
  })

  it('posix 구분자도 같게 동작한다', () => {
    const counts = folderCounts(['/proj/src/a.ts', '/proj/src/b.ts'], '/proj')
    expect(counts['/proj/src']).toBe(2)
    expect(counts['/proj']).toBe(2)
  })

  it('루트 밖 경로는 세지 않는다 — 형제 접두사에 속지 않는다', () => {
    // 'D:\proj2'는 'D:\proj'로 시작하지만 루트 하위가 아니다
    const counts = folderCounts(['D:\\proj2\\a.ts'], 'D:\\proj')
    expect(counts).toEqual({})
  })

  it('루트 바로 아래 파일은 루트만 센다', () => {
    expect(folderCounts(['D:\\proj\\a.ts'], 'D:\\proj')).toEqual({ 'D:\\proj': 1 })
  })

  it('빈 입력은 빈 객체', () => {
    expect(folderCounts([], 'D:\\proj')).toEqual({})
  })
})
