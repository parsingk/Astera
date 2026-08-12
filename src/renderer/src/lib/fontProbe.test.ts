import { afterEach, describe, expect, it, vi } from 'vitest'
import { listLocalFontFamilies } from './fontProbe'

afterEach(() => {
  vi.unstubAllGlobals()
  // the module caches its result — reset it between cases
  vi.resetModules()
})

describe('listLocalFontFamilies', () => {
  it('deduplicates by family, sorts, and drops unusable names', async () => {
    vi.stubGlobal('queryLocalFonts', async () => [
      { family: 'Fira Code' },
      { family: 'Fira Code' }, // a second style of the same family
      { family: 'Consolas' },
      { family: 'Bad"Name' }
    ])
    const { listLocalFontFamilies: fresh } = await import('./fontProbe')
    expect(await fresh()).toEqual(['Consolas', 'Fira Code'])
  })

  it('returns an empty list when the API is missing', async () => {
    vi.stubGlobal('queryLocalFonts', undefined)
    const { listLocalFontFamilies: fresh } = await import('./fontProbe')
    await expect(fresh()).resolves.toEqual([])
  })

  it('propagates a rejection so the caller can report it', async () => {
    vi.stubGlobal('queryLocalFonts', async () => {
      throw new Error('denied')
    })
    const { listLocalFontFamilies: fresh } = await import('./fontProbe')
    await expect(fresh()).rejects.toThrow('denied')
  })
})
