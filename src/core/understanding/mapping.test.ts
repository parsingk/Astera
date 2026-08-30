import { describe, it, expect } from 'vitest'
import { mapFilesToFeatures } from './mapping'

const features = [
  { featureId: 'auth', paths: ['src/auth', 'src/core/session.ts'] },
  { featureId: 'noti', paths: ['src/notifications'] },
  { featureId: 'admin', paths: ['src/admin'] }
]

describe('mapFilesToFeatures — 경로 겹침으로 기능을 고른다', () => {
  it('디렉터리 아래의 파일이 그 기능에 속한다', () => {
    expect(mapFilesToFeatures(['src/auth/login.ts'], features)).toEqual(['auth'])
  })

  it('파일 경로가 정확히 같아도 속한다', () => {
    expect(mapFilesToFeatures(['src/core/session.ts'], features)).toEqual(['auth'])
  })

  // 'src/auth' 가 'src/authors/…' 를 삼키면 남의 파일이 인증 기능의 변화가 된다
  it('접두사가 같아도 경로 조각이 다르면 속하지 않는다', () => {
    expect(mapFilesToFeatures(['src/authors/list.ts'], features)).toEqual([])
  })

  it('여러 기능이 겹치면 전부, 겹친 파일 수 내림차순이다', () => {
    const changed = ['src/noti/x.ts', 'src/notifications/a.ts', 'src/notifications/b.ts', 'src/auth/y.ts']
    expect(mapFilesToFeatures(changed, features)).toEqual(['noti', 'auth'])
  })

  it('같은 수면 기능 목록의 순서(사이드바 순서)를 지킨다', () => {
    const changed = ['src/auth/a.ts', 'src/notifications/b.ts']
    expect(mapFilesToFeatures(changed, features)).toEqual(['auth', 'noti'])
  })

  it('겹침이 없으면 빈 목록이다 — 새 기능을 지어내지 않는다', () => {
    expect(mapFilesToFeatures(['docs/readme.md'], features)).toEqual([])
    expect(mapFilesToFeatures([], features)).toEqual([])
    expect(mapFilesToFeatures(['src/auth/a.ts'], [])).toEqual([])
  })

  // git status 는 슬래시를 주지만 에이전트가 만든 구현 경로는 표기가 흔들릴 수 있다
  it('역슬래시·./ ·끝 슬래시 표기가 달라도 같은 경로로 본다', () => {
    const f = [{ featureId: 'auth', paths: ['.\\src\\auth\\'] }]
    expect(mapFilesToFeatures(['src/auth/login.ts'], f)).toEqual(['auth'])
    expect(mapFilesToFeatures(['./src/auth/login.ts'], f)).toEqual(['auth'])
  })

  it('빈 문자열 구현 경로는 모든 파일을 삼키지 않는다', () => {
    const f = [{ featureId: 'broken', paths: [''] }]
    expect(mapFilesToFeatures(['src/a.ts'], f)).toEqual([])
  })
})
