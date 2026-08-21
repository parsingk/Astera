import { describe, expect, it } from 'vitest'
import { schedRuleSummary } from './summary'
import { CATALOGS } from '../i18n'
import type { MessageKey, MessageParams } from '../i18n'

// 실제 한국어 카탈로그로 문장을 만든다 — 자리표시자 이름이 어긋나면 여기서 드러난다
const t = (key: MessageKey, params?: MessageParams): string => {
  const raw = CATALOGS.ko.messages[key] as string
  return params
    ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k]))
    : raw
}

describe('schedRuleSummary', () => {
  it('interval', () => {
    expect(schedRuleSummary(t, { kind: 'interval', minutes: 30 })).toBe('30분마다')
  })
  it('daily', () => {
    expect(schedRuleSummary(t, { kind: 'daily', time: '09:00' })).toBe('매일 09:00')
  })
  it('weekly — 요일을 가운뎃점으로 잇는다', () => {
    expect(schedRuleSummary(t, { kind: 'weekly', weekdays: [1, 3], time: '09:00' })).toBe(
      '매주 월·수 09:00'
    )
  })
  it('monthly', () => {
    expect(schedRuleSummary(t, { kind: 'monthly', days: [1, 15], time: '09:00' })).toBe(
      '매월 1·15일 09:00'
    )
  })
  it('규칙이 없으면 대체 문구', () => {
    expect(schedRuleSummary(t, undefined)).toBe('스케쥴')
  })
})
