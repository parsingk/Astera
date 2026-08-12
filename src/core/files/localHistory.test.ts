import { describe, expect, it } from 'vitest'
import {
  MAX_AGE_MS,
  MAX_TOTAL_BYTES,
  projectKey,
  normalizeProjectPath,
  selectEvictions,
  snapshotId,
  tooLarge,
  type HistoryEntry
} from './localHistory'

const E = (id: string, deletedAt: number, size: number): HistoryEntry => ({
  id,
  originalPath: `D:\\p\\${id}`,
  deletedAt,
  size,
  isDir: false
})

describe('projectKey', () => {
  it('같은 경로는 같은 키', () => {
    expect(projectKey('D:\\proj')).toBe(projectKey('D:\\proj'))
  })

  it('구분자·대소문자 차이를 무시한다 (win32)', () => {
    expect(projectKey('d:/PROJ')).toBe(projectKey('D:\\proj'))
  })

  it('끝 구분자를 무시한다', () => {
    expect(projectKey('D:\\proj\\')).toBe(projectKey('D:\\proj'))
  })

  it('다른 경로는 다른 키', () => {
    expect(projectKey('D:\\a')).not.toBe(projectKey('D:\\b'))
  })

  it('디렉터리 이름으로 쓸 수 있는 문자만 낸다', () => {
    expect(projectKey('D:\\proj with space\\한글')).toMatch(/^[0-9a-z]+$/)
  })
})

describe('snapshotId', () => {
  it('타임스탬프-이름 형식이고 정렬 가능하다', () => {
    const a = snapshotId(1000, 'a.txt', [])
    const b = snapshotId(2000, 'a.txt', [])
    expect(a < b).toBe(true)
  })

  it('원래 이름을 담는다', () => {
    expect(snapshotId(1000, 'report.md', [])).toContain('report.md')
  })

  it('같은 밀리초에 같은 이름이 겹치면 접미로 회피한다', () => {
    const first = snapshotId(1000, 'a.txt', [])
    const second = snapshotId(1000, 'a.txt', [first])
    expect(second).not.toBe(first)
    const third = snapshotId(1000, 'a.txt', [first, second])
    expect(third).not.toBe(first)
    expect(third).not.toBe(second)
  })

  it('디렉터리 이름에 쓸 수 없는 문자를 치환한다', () => {
    expect(snapshotId(1000, 'a:b?c*d', [])).not.toMatch(/[:?*]/)
  })
})

describe('tooLarge', () => {
  it('50MB 이하는 스냅샷한다', () => {
    expect(tooLarge(50 * 1024 * 1024)).toBe(false)
  })

  it('50MB를 넘으면 스냅샷하지 않는다', () => {
    expect(tooLarge(50 * 1024 * 1024 + 1)).toBe(true)
  })
})

describe('selectEvictions', () => {
  const now = 1_000_000_000_000

  it('한도 안이면 아무것도 축출하지 않는다', () => {
    expect(selectEvictions([E('a', now, 10), E('b', now, 20)], now)).toEqual([])
  })

  it('보관 기간을 넘긴 것을 축출한다', () => {
    const old = now - MAX_AGE_MS - 1
    expect(selectEvictions([E('old', old, 10), E('new', now, 10)], now)).toEqual(['old'])
  })

  it('경계(정확히 30일)는 남긴다', () => {
    expect(selectEvictions([E('edge', now - MAX_AGE_MS, 10)], now)).toEqual([])
  })

  it('총량을 넘으면 오래된 것부터 축출한다', () => {
    const entries = [
      E('oldest', now - 3000, MAX_TOTAL_BYTES / 2),
      E('mid', now - 2000, MAX_TOTAL_BYTES / 2),
      E('newest', now - 1000, MAX_TOTAL_BYTES / 2)
    ]
    // 셋을 다 두면 1.5배 → 가장 오래된 하나를 버리면 딱 한도
    expect(selectEvictions(entries, now)).toEqual(['oldest'])
  })

  it('총량을 맞추려면 여러 개도 축출한다', () => {
    const entries = [
      E('a', now - 4000, MAX_TOTAL_BYTES),
      E('b', now - 3000, MAX_TOTAL_BYTES),
      E('c', now - 2000, MAX_TOTAL_BYTES)
    ]
    expect(selectEvictions(entries, now)).toEqual(['a', 'b'])
  })

  it('기간 초과와 총량 초과가 겹쳐도 중복 없이 낸다', () => {
    const old = now - MAX_AGE_MS - 1
    const entries = [E('old', old, MAX_TOTAL_BYTES), E('new', now, MAX_TOTAL_BYTES)]
    const out = selectEvictions(entries, now)
    expect(out).toEqual(['old'])
    expect(new Set(out).size).toBe(out.length)
  })

  it('입력 순서와 무관하게 오래된 것부터 고른다', () => {
    const entries = [E('new', now - 1000, MAX_TOTAL_BYTES), E('old', now - 9000, MAX_TOTAL_BYTES)]
    expect(selectEvictions(entries, now)).toEqual(['old'])
  })

  it('빈 목록은 빈 배열', () => {
    expect(selectEvictions([], now)).toEqual([])
  })
})

describe('normalizeProjectPath', () => {
  it('구분자·대소문자·끝 구분자를 정규화한다 — index.json의 키가 된다', () => {
    expect(normalizeProjectPath('d:/PROJ\\')).toBe(normalizeProjectPath('D:\\proj'))
  })

  it('다른 프로젝트는 다른 키 (해시와 달리 충돌하지 않는다)', () => {
    expect(normalizeProjectPath('D:\\a')).not.toBe(normalizeProjectPath('D:\\b'))
  })
})
