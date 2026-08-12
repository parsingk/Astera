import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS, isLang, t } from './index'
import { ko } from './messages/ko'
import { en } from './messages/en'

describe('t', () => {
  it('한국어 문구를 반환한다', () => {
    expect(t('ko', 'settings.title')).toBe('설정')
  })
  it('영어 문구를 반환한다', () => {
    expect(t('en', 'settings.title')).toBe('Settings')
  })
  it('자리표시자를 치환한다', () => {
    expect(t('ko', 'files.validate.badChar', { char: '<' })).toBe('이름에 쓸 수 없는 문자가 있습니다: <')
  })
  it('영어 템플릿도 치환한다', () => {
    expect(t('en', 'files.validate.badChar', { char: '|' })).toBe(
      'Name contains an unusable character: |'
    )
  })
  it('숫자 파라미터도 문자열로 치환한다', () => {
    expect(t('ko', 'files.validate.badChar', { char: 1 })).toBe('이름에 쓸 수 없는 문자가 있습니다: 1')
  })
  it('파라미터가 없으면 자리표시자를 그대로 남긴다 — 조용히 지우면 원인 추적이 어렵다', () => {
    expect(t('ko', 'files.validate.badChar', {})).toBe('이름에 쓸 수 없는 문자가 있습니다: {char}')
  })
  it('params를 아예 넘기지 않아도 템플릿 원문을 반환한다', () => {
    expect(t('ko', 'files.validate.badChar')).toBe('이름에 쓸 수 없는 문자가 있습니다: {char}')
  })
})

describe('카탈로그', () => {
  it('ko와 en의 키 집합이 일치한다 (1차 방어는 typecheck, 이건 보조)', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ko).sort())
  })
  it('빈 문구가 없다', () => {
    for (const [k, v] of Object.entries(en)) expect(v, k).not.toBe('')
    for (const [k, v] of Object.entries(ko)) expect(v, k).not.toBe('')
  })
})

describe('CATALOGS', () => {
  it('네 언어를 모두 담는다', () => {
    expect(LANGS.sort()).toEqual(['en', 'es', 'ja', 'ko'])
  })
  it('언어마다 자기 언어로 쓴 이름을 가진다', () => {
    expect(CATALOGS.ko.nativeName).toBe('한국어')
    expect(CATALOGS.en.nativeName).toBe('English')
    expect(CATALOGS.ja.nativeName).toBe('日本語')
    expect(CATALOGS.es.nativeName).toBe('Español')
  })
})

describe('isLang', () => {
  it('지원 언어를 받아들인다', () => {
    for (const l of LANGS) expect(isLang(l)).toBe(true)
  })
  it('system, null, 쓰레기값을 거부한다', () => {
    expect(isLang('system')).toBe(false)
    expect(isLang(null)).toBe(false)
    expect(isLang(undefined)).toBe(false)
    expect(isLang('zh')).toBe(false)
    expect(isLang(1)).toBe(false)
  })
})

describe('t 폴백', () => {
  it('요청한 언어에 있으면 그것을 쓴다', () => {
    expect(t('ko', 'settings.title')).toBe('설정')
    expect(t('en', 'settings.title')).toBe('Settings')
  })
  it('부분 카탈로그에 없는 키는 영어로 내려간다', () => {
    // ja는 부분 카탈로그다. 아직 비어 있어도, 번역이 채워져도 이 성질은 같아야 한다
    const key = 'settings.title'
    expect(t('ja', key)).toBe(CATALOGS.ja.messages[key] ?? 'Settings')
  })
  it('영어에도 없으면 한국어까지 내려간다', () => {
    // en은 타입상 완전하므로 런타임에서만 만들 수 있는 상황이다
    // ja도 이 키를 갖고 있으면 폴백이 시작되지 않으므로 둘 다 비운다
    const gap = CATALOGS.en.messages as Record<string, string>
    const partial = CATALOGS.ja.messages as Record<string, string>
    const saved = gap['settings.title']
    const savedJa = partial['settings.title']
    delete gap['settings.title']
    delete partial['settings.title']
    try {
      expect(t('ja', 'settings.title')).toBe('설정')
    } finally {
      gap['settings.title'] = saved
      if (savedJa !== undefined) partial['settings.title'] = savedJa
    }
  })
  it('폴백된 문구에도 자리표시자를 치환한다', () => {
    expect(t('ja', 'files.validate.badChar', { char: '<' })).toContain('<')
  })
})
