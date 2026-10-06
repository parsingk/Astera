import { describe, it, expect, vi } from 'vitest'
import { cachedResolver } from './terminalLinks'

describe('cachedResolver', () => {
  it('a hit is cached: the same target is resolved once', async () => {
    const resolve = vi.fn(async () => 'D:\\out\\a.png')
    const r = cachedResolver(resolve, () => 0)
    expect(await r('a.png')).toBe('D:\\out\\a.png')
    expect(await r('a.png')).toBe('D:\\out\\a.png')
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  // An agent prints the output path in its tool call before the file is written; the first hover
  // misses. A miss kept forever meant that path never became a link for the terminal's life.
  it('a miss is remembered only briefly, then asked again', async () => {
    let now = 0
    const resolve = vi.fn(async (): Promise<string | null> => null)
    const r = cachedResolver(resolve, () => now, 5000)
    expect(await r('a.png')).toBeNull()
    now = 4999
    expect(await r('a.png')).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(1) // still within the window: the hover storm is absorbed
    resolve.mockResolvedValueOnce('D:\\out\\a.png')
    now = 5000
    expect(await r('a.png')).toBe('D:\\out\\a.png')
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('a rejection is a miss, with the same short memory', async () => {
    let now = 0
    const resolve = vi.fn(async (): Promise<string | null> => {
      throw new Error('ipc')
    })
    const r = cachedResolver(resolve, () => now, 5000)
    expect(await r('a.png')).toBeNull()
    now = 6000
    expect(await r('a.png')).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('a request still in flight is shared, not repeated', async () => {
    let finish: (v: string | null) => void = () => {}
    const resolve = vi.fn(() => new Promise<string | null>((res) => (finish = res)))
    const r = cachedResolver(resolve, () => 0)
    const a = r('a.png')
    const b = r('a.png')
    finish('/out/a.png')
    expect(await a).toBe('/out/a.png')
    expect(await b).toBe('/out/a.png')
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})
