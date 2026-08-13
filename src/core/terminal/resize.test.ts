import { describe, it, expect } from 'vitest'
import { nextResize } from './resize'

describe('nextResize', () => {
  it('last가 null이면(첫 전송) 항상 치수를 반환한다', () => {
    expect(nextResize(null, 120, 30)).toEqual({ cols: 120, rows: 30 })
  })

  it('치수가 직전과 동일하면 null(전송 스킵)', () => {
    expect(nextResize({ cols: 120, rows: 30 }, 120, 30)).toBeNull()
  })

  it('cols가 바뀌면 새 치수를 반환한다', () => {
    expect(nextResize({ cols: 120, rows: 30 }, 118, 30)).toEqual({ cols: 118, rows: 30 })
  })

  it('rows가 바뀌면 새 치수를 반환한다', () => {
    expect(nextResize({ cols: 120, rows: 30 }, 120, 29)).toEqual({ cols: 120, rows: 29 })
  })
})
