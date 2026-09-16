import { beforeEach, describe, expect, it } from 'vitest'
import { read, write } from './sessionKindPref'

/** vitest는 environment: 'node'로 돌아 localStorage가 없다. Map으로 백업한 최소 구현을
 *  globalThis에 심어 둔다 (stickyProject.test.ts와 같은 패턴). */
function installStorage(opts: { failGetItem?: boolean; failSetItem?: boolean } = {}): Map<string, string> {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string): string | null => {
      if (opts.failGetItem) throw new Error('storage disabled')
      return store.has(k) ? (store.get(k) as string) : null
    },
    setItem: (k: string, v: string): void => {
      if (opts.failSetItem) throw new Error('quota exceeded')
      store.set(k, v)
    },
    removeItem: (k: string): void => {
      store.delete(k)
    }
  }
  return store
}

beforeEach(() => {
  installStorage()
})

describe('sessionKindPref', () => {
  it('저장된 것이 없으면 terminal이다', () => {
    expect(read()).toBe('terminal')
  })

  it('write 후 read하면 chat이 왕복한다', () => {
    write('chat')
    expect(read()).toBe('chat')
  })

  it('write 후 read하면 terminal도 왕복한다', () => {
    write('chat')
    write('terminal')
    expect(read()).toBe('terminal')
  })

  it('알 수 없는 값이 저장돼 있으면 terminal이다', () => {
    const store = installStorage()
    store.set('newSession.kind', 'bogus')
    expect(read()).toBe('terminal')
  })

  it('읽기 실패해도 던지지 않고 terminal로 떨어진다', () => {
    installStorage({ failGetItem: true })
    expect(() => read()).not.toThrow()
    expect(read()).toBe('terminal')
  })

  it('쓰기 실패해도 던지지 않는다', () => {
    installStorage({ failSetItem: true })
    expect(() => write('chat')).not.toThrow()
  })
})
