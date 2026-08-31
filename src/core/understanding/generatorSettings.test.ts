import { describe, it, expect } from 'vitest'
import { readGeneratorSettings, writableGeneratorSettings } from './generatorSettings'

describe('readGeneratorSettings — 손으로 고칠 수 있는 파일에서 읽는다', () => {
  it('세 값을 그대로 읽는다', () => {
    expect(readGeneratorSettings({ accountId: 'a1', model: 'sonnet', effort: 'high' })).toEqual({
      accountId: 'a1',
      model: 'sonnet',
      effort: 'high'
    })
  })

  it('일부만 있어도 그것만 읽는다', () => {
    expect(readGeneratorSettings({ accountId: 'a1' })).toEqual({ accountId: 'a1' })
  })

  // 입력칸을 비운 것이 곧 "기본값을 쓰겠다"이다 — 빈 문자열이 --model 로 넘어가면 CLI 가 죽는다
  it('빈 문자열과 공백은 없는 것과 같다', () => {
    expect(readGeneratorSettings({ accountId: '', model: '  ', effort: '\t' })).toEqual({})
  })

  it('앞뒤 공백을 깎는다 — 복사·붙여넣기가 흔한 자리다', () => {
    expect(readGeneratorSettings({ model: '  sonnet ' })).toEqual({ model: 'sonnet' })
  })

  it('모양이 아니면 지정되지 않은 것으로 본다 — 던지지 않는다', () => {
    expect(readGeneratorSettings(null)).toEqual({})
    expect(readGeneratorSettings('sonnet')).toEqual({})
    expect(readGeneratorSettings([])).toEqual({})
    expect(readGeneratorSettings({ accountId: 42, model: true })).toEqual({})
  })
})

describe('writableGeneratorSettings — 빈 설정은 파일에 키를 남기지 않는다', () => {
  it('값이 하나라도 있으면 그 값들만', () => {
    expect(writableGeneratorSettings({ accountId: 'a1' })).toEqual({ accountId: 'a1' })
  })

  it('전부 비면 undefined 다', () => {
    expect(writableGeneratorSettings({})).toBeUndefined()
    expect(writableGeneratorSettings({ accountId: '', model: '' })).toBeUndefined()
  })
})
