import { beforeEach, describe, expect, it, vi } from 'vitest'

// 모듈 싱글턴이라 테스트마다 새로 import해 상태를 격리한다 (worktreeBus.test.ts와 같은 방식)
let mod: typeof import('./hiddenProjects')
let store: Record<string, string>
let writes = 0

/** vitest는 environment: 'node'로 돌아 localStorage가 없다. 모듈이 첫 사용 시점에 읽으므로
 *  import 전에 최소 구현을 심어 둔다. */
function installStorage(initial: Record<string, string> = {}, opts: { failSetItem?: boolean } = {}): void {
  store = { ...initial }
  writes = 0
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string): string | null => (k in store ? store[k] : null),
    setItem: (k: string, v: string): void => {
      if (opts.failSetItem) throw new Error('quota exceeded')
      writes++
      store[k] = v
    },
    removeItem: (k: string): void => {
      delete store[k]
    }
  }
}

const load = async (initial?: Record<string, string>, opts?: { failSetItem?: boolean }): Promise<void> => {
  vi.resetModules()
  installStorage(initial, opts)
  mod = await import('./hiddenProjects')
}

beforeEach(async () => {
  await load()
})

describe('hiddenProjects', () => {
  it('hide한 경로가 목록에 들어간다', () => {
    mod.hide('D:\\work\\a')
    expect(mod.list()).toEqual(['D:\\work\\a'])
  })

  it('같은 경로를 여러 번 hide해도 한 번만 들어간다', () => {
    mod.hide('D:\\work\\a')
    mod.hide('D:\\work\\a')
    expect(mod.list()).toEqual(['D:\\work\\a'])
  })

  it('unhide하면 제거된다', () => {
    mod.hide('D:\\work\\a')
    mod.hide('D:\\work\\b')
    mod.unhide('D:\\work\\a')
    expect(mod.list()).toEqual(['D:\\work\\b'])
  })

  it('없는 경로 unhide는 무해하고 통지도 하지 않는다', () => {
    let calls = 0
    mod.subscribe(() => calls++)
    mod.unhide('D:\\work\\nope')
    expect(mod.list()).toEqual([])
    expect(calls).toBe(0)
  })

  it('중복 hide는 통지하지 않는다', () => {
    mod.hide('D:\\work\\a')
    let calls = 0
    mod.subscribe(() => calls++)
    mod.hide('D:\\work\\a')
    expect(calls).toBe(0)
  })

  it('hide와 unhide 양쪽에서 구독자에게 통지한다', () => {
    let calls = 0
    mod.subscribe(() => calls++)
    mod.hide('D:\\work\\a')
    mod.unhide('D:\\work\\a')
    expect(calls).toBe(2)
  })

  it('구독 해제 후에는 통지받지 않는다', () => {
    let calls = 0
    const off = mod.subscribe(() => calls++)
    off()
    mod.hide('D:\\work\\a')
    expect(calls).toBe(0)
  })

  it('localStorage에 영속되어 다시 읽힌다', async () => {
    mod.hide('D:\\work\\a')
    const raw = store['cm.historyHidden']
    await load({ 'cm.historyHidden': raw })
    expect(mod.list()).toEqual(['D:\\work\\a'])
  })

  it('손상된 JSON이면 빈 목록으로 복구한다', async () => {
    await load({ 'cm.historyHidden': '{not json' })
    expect(mod.list()).toEqual([])
  })

  it('배열이 아닌 값이면 빈 목록으로 복구한다', async () => {
    await load({ 'cm.historyHidden': '{"a":1}' })
    expect(mod.list()).toEqual([])
  })

  it('문자열이 아닌 항목은 걸러낸다', async () => {
    await load({ 'cm.historyHidden': '["D:\\\\work\\\\a",3,null]' })
    expect(mod.list()).toEqual(['D:\\work\\a'])
  })

  it('저장값을 정규화하지 않는다 — 대소문자가 보존된다', () => {
    mod.hide('D:\\Work\\MyApp')
    expect(mod.list()).toEqual(['D:\\Work\\MyApp'])
  })

  it('영속 실패해도 세션 내 변경과 통지는 유지된다', async () => {
    await load(undefined, { failSetItem: true })
    let calls = 0
    mod.subscribe(() => calls++)
    expect(() => mod.hide('D:\\work\\a')).not.toThrow()
    expect(mod.list()).toEqual(['D:\\work\\a'])
    expect(calls).toBe(1)
  })

  // 정리 기능은 한 번에 수십 개를 지운다. unhide 를 그만큼 돌리면 localStorage 쓰기와 리렌더가
  // 그 횟수만큼 일어나므로, 한 번에 지우고 한 번만 알리는 경로를 따로 둔다.
  it('unhideMany는 여러 경로를 한 번에 제거한다', () => {
    mod.hide('D:\\work\\a')
    mod.hide('D:\\work\\b')
    mod.hide('D:\\work\\c')
    mod.unhideMany(['D:\\work\\a', 'D:\\work\\c'])
    expect(mod.list()).toEqual(['D:\\work\\b'])
  })

  it('unhideMany는 지운 개수와 무관하게 한 번만 통지한다', () => {
    mod.hide('D:\\work\\a')
    mod.hide('D:\\work\\b')
    let calls = 0
    mod.subscribe(() => calls++)
    mod.unhideMany(['D:\\work\\a', 'D:\\work\\b'])
    expect(calls).toBe(1)
  })

  it('unhideMany는 지운 개수와 무관하게 한 번만 저장한다', () => {
    mod.hide('D:\\work\\a')
    mod.hide('D:\\work\\b')
    writes = 0
    mod.unhideMany(['D:\\work\\a', 'D:\\work\\b'])
    expect(writes).toBe(1)
  })

  it('unhideMany에 없는 경로가 섞여 있어도 있는 것만 지운다', () => {
    mod.hide('D:\\work\\a')
    mod.unhideMany(['D:\\work\\a', 'D:\\work\\nope'])
    expect(mod.list()).toEqual([])
  })

  it('unhideMany가 아무것도 지우지 못하면 통지하지 않는다', () => {
    mod.hide('D:\\work\\a')
    let calls = 0
    mod.subscribe(() => calls++)
    mod.unhideMany(['D:\\work\\nope'])
    expect(calls).toBe(0)
    expect(mod.list()).toEqual(['D:\\work\\a'])
  })

  it('unhideMany에 빈 목록을 주면 아무 일도 하지 않는다', () => {
    mod.hide('D:\\work\\a')
    let calls = 0
    mod.subscribe(() => calls++)
    mod.unhideMany([])
    expect(calls).toBe(0)
    expect(mod.list()).toEqual(['D:\\work\\a'])
  })

  it('unhideMany는 남은 항목의 순서를 유지한다', () => {
    mod.hide('D:\\z\\last')
    mod.hide('D:\\m\\mid')
    mod.hide('D:\\a\\first')
    mod.unhideMany(['D:\\m\\mid'])
    expect(mod.list()).toEqual(['D:\\z\\last', 'D:\\a\\first'])
  })

})
