import { describe, it, expect } from 'vitest'
import { armScript, badgesScript, cancelScript, embedJson, highlightScript, type BadgeMarker } from './pickScripts'

const marker: BadgeMarker = { seq: 7, rectPage: { x: 1, y: 2, width: 3, height: 4 }, rectViewport: { x: 5, y: 6, width: 3, height: 4 }, isFixed: false }
const parses = (src: string): void => {
  expect(() => new Function(src)).not.toThrow()
}

describe('pick scripts', () => {
  it('every script is syntactically valid JavaScript', () => {
    parses(armScript())
    parses(cancelScript())
    parses(badgesScript([]))
    parses(badgesScript([marker]))
    parses(highlightScript(marker))
    parses(highlightScript({ ...marker, isFixed: true }))
  })

  it('names its globals so a second injection finds the first', () => {
    expect(armScript()).toContain('__asteraPick')
    expect(cancelScript()).toContain('__asteraPick')
    expect(badgesScript([])).toContain('__asteraBadges')
  })

  it('embeds the markers as data the guest reads back unchanged', () => {
    const src = badgesScript([marker])
    expect(src).toContain('"seq":7')
    expect(src).toContain('"isFixed":false')
  })

  it('a fixed element is highlighted at its viewport rect, a normal one at its page rect', () => {
    expect(highlightScript(marker)).toContain('"x":1')
    expect(highlightScript({ ...marker, isFixed: true })).toContain('"x":5')
  })

  it('does not reference module scope from inside the runtime', () => {
    // A stringified function that closed over an import would name it here and fail at run time in the guest.
    for (const src of [armScript(), cancelScript(), badgesScript([]), highlightScript(marker)]) {
      expect(src).not.toMatch(/\bimport\b|\brequire\(|__vite|\bexports\b/)
    }
  })
})

describe('embedJson', () => {
  it('escapes what could end a script or a line, and still evaluates to the same value', () => {
    const hostile = ['</script>', '<!--', '&', '`', '\u2028', '\u2029']
    const out = embedJson(hostile)
    expect(out).not.toContain('<')
    expect(out).not.toContain('>')
    expect(out).not.toContain('&')
    expect(out).not.toContain('\u2028')
    expect(out).not.toContain('\u2029')
    expect(new Function(`return ${out}`)()).toEqual(hostile)
  })
})
