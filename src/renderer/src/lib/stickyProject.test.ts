import { beforeEach, describe, expect, it, vi } from 'vitest'

// 모듈 싱글턴이라 테스트마다 새로 import해 상태를 격리한다 (hiddenProjects.test.ts와 같은 방식)
let mod: typeof import('./stickyProject')
let store: Record<string, string>

/** vitest는 environment: 'node'로 돌아 localStorage가 없다. 모듈이 첫 사용 시점에 읽으므로
 *  import 전에 최소 구현을 심어 둔다. */
function installStorage(
  initial: Record<string, string> = {},
  opts: { failSetItem?: boolean; failGetItem?: boolean } = {}
): void {
  store = { ...initial }
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string): string | null => {
      if (opts.failGetItem) throw new Error('storage disabled')
      return k in store ? store[k] : null
    },
    setItem: (k: string, v: string): void => {
      if (opts.failSetItem) throw new Error('quota exceeded')
      store[k] = v
    },
    removeItem: (k: string): void => {
      delete store[k]
    }
  }
}

const load = async (
  initial?: Record<string, string>,
  opts?: { failSetItem?: boolean; failGetItem?: boolean }
): Promise<void> => {
  vi.resetModules()
  installStorage(initial, opts)
  mod = await import('./stickyProject')
}

beforeEach(async () => {
  await load()
})

describe('stickyProject', () => {
  it('저장한 경로를 다시 읽는다', async () => {
    mod.write('D:\\work\\a')
    await load({ 'cm.currentProject': store['cm.currentProject'] })
    expect(mod.read()).toBe('D:\\work\\a')
  })

  it('저장된 것이 없으면 null이다', () => {
    expect(mod.read()).toBeNull()
  })

  it('마지막으로 쓴 값만 남는다', async () => {
    mod.write('D:\\work\\a')
    mod.write('D:\\work\\b')
    await load({ 'cm.currentProject': store['cm.currentProject'] })
    expect(mod.read()).toBe('D:\\work\\b')
  })

  it('clear하면 null이 된다', () => {
    mod.write('D:\\work\\a')
    mod.clear()
    expect(mod.read()).toBeNull()
  })

  it('저장된 것이 없어도 clear는 무해하다', () => {
    expect(() => mod.clear()).not.toThrow()
    expect(mod.read()).toBeNull()
  })

  // 빈 값은 없는 것으로 취급한다 — 빈 경로가 흘러가면 files.list 가 프로젝트 루트 대신
  // 프로세스의 작업 디렉터리를 읽으려 들고, 실패의 원인이 저장값이라는 것도 드러나지 않는다
  it('빈 문자열이 저장돼 있으면 null이다', async () => {
    await load({ 'cm.currentProject': '' })
    expect(mod.read()).toBeNull()
  })

  it('공백뿐인 값이 저장돼 있으면 null이다', async () => {
    await load({ 'cm.currentProject': '   ' })
    expect(mod.read()).toBeNull()
  })

  it('경로를 정규화하지 않는다 — 대소문자가 보존된다', async () => {
    mod.write('D:\\Work\\MyApp')
    await load({ 'cm.currentProject': store['cm.currentProject'] })
    expect(mod.read()).toBe('D:\\Work\\MyApp')
  })

  it('영속 실패해도 던지지 않는다', async () => {
    await load(undefined, { failSetItem: true })
    expect(() => mod.write('D:\\work\\a')).not.toThrow()
  })

  it('읽기 실패해도 던지지 않고 null이다', async () => {
    await load({ 'cm.currentProject': 'D:\\work\\a' }, { failGetItem: true })
    expect(mod.read()).toBeNull()
  })
})
