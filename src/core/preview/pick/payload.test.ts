import { describe, it, expect } from 'vitest'
import { clampPayload, isSecretName, sanitizeUrl } from './payload'
import { PICK_BUDGET, STYLE_KEYS } from './types'

const styles = Object.fromEntries(STYLE_KEYS.map((k) => [k, 'x']))
const raw = {
  page: { url: 'http://localhost:5173/pricing?plan=pro', title: 'Pricing', viewportWidth: 1280, viewportHeight: 720, devicePixelRatio: 2 },
  tagName: 'button',
  selector: '#save',
  elementPath: 'main > header > button.cta',
  cssClasses: 'cta primary',
  textSnippet: 'Save',
  htmlSnippet: '<button id="save" class="cta primary">Save</button>',
  attributes: { id: 'save', class: 'cta primary' },
  accessibility: { role: null, accessibleName: 'Save' },
  rectViewport: { x: 812, y: 24, width: 96, height: 36 },
  rectPage: { x: 812, y: 24, width: 96, height: 36 },
  isFixed: false,
  computedStyles: styles,
  nearbyText: ['Pricing', 'Save changes to your plan'],
  reactComponents: '<App> <Header> <Button>',
  sourceFile: 'src/Header.tsx:42:7'
}

describe('clampPayload', () => {
  it('passes a well-formed payload through unchanged', () => {
    expect(clampPayload(raw)).toEqual(raw)
  })

  it('clamps every string to its budget', () => {
    const long = 'x'.repeat(10_000)
    const out = clampPayload({ ...raw, textSnippet: long, htmlSnippet: long, selector: long, elementPath: long, cssClasses: long, reactComponents: long, sourceFile: long })!
    expect(out.textSnippet).toHaveLength(PICK_BUDGET.textSnippet)
    expect(out.htmlSnippet).toHaveLength(PICK_BUDGET.htmlSnippet)
    expect(out.selector).toHaveLength(PICK_BUDGET.selector)
    expect(out.elementPath).toHaveLength(PICK_BUDGET.elementPath)
    expect(out.cssClasses).toHaveLength(PICK_BUDGET.cssClasses)
    expect(out.reactComponents).toHaveLength(PICK_BUDGET.reactComponents)
    expect(out.sourceFile).toHaveLength(PICK_BUDGET.sourceFile)
  })

  it('caps nearbyText entries and their length, and attributes at forty', () => {
    const many = Array.from({ length: 30 }, (_, i) => `t${i}` + 'y'.repeat(500))
    const attrs = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`data-a${i}`, 'v']))
    const out = clampPayload({ ...raw, nearbyText: many, attributes: attrs })!
    expect(out.nearbyText).toHaveLength(PICK_BUDGET.nearbyTextEntries)
    expect(out.nearbyText[0]).toHaveLength(PICK_BUDGET.nearbyTextEntry)
    expect(Object.keys(out.attributes)).toHaveLength(PICK_BUDGET.attributes)
  })

  it('redacts secret-looking attributes by name and by value', () => {
    const out = clampPayload({
      ...raw,
      attributes: { 'data-token': 'abc', Authorization: 'Bearer x', 'x-api-key': 'k', title: 'fine', 'data-hash': 'a'.repeat(40) }
    })!
    expect(out.attributes['data-token']).toBe('[redacted]')
    expect(out.attributes.Authorization).toBe('[redacted]')
    expect(out.attributes['x-api-key']).toBe('[redacted]')
    expect(out.attributes.title).toBe('fine')
    expect(out.attributes['data-hash']).toBe('[redacted]')
  })

  it('keeps http(s) URLs minus sensitive query parameters, and drops other schemes', () => {
    expect(clampPayload({ ...raw, page: { ...raw.page, url: 'http://localhost:5173/a?token=1&page=2' } })!.page.url).toBe('http://localhost:5173/a?page=2')
    expect(clampPayload({ ...raw, page: { ...raw.page, url: 'javascript:alert(1)' } })!.page.url).toBe('')
    expect(clampPayload({ ...raw, page: { ...raw.page, url: 'file:///C:/x' } })!.page.url).toBe('')
  })

  it('null for anything that is not a payload', () => {
    expect(clampPayload(null)).toBeNull()
    expect(clampPayload([])).toBeNull()
    expect(clampPayload('x')).toBeNull()
    const { rectViewport: _r, ...missing } = raw
    expect(clampPayload(missing)).toBeNull()
    expect(clampPayload({ ...raw, rectViewport: { x: Number.NaN, y: 0, width: 1, height: 1 } })).toBeNull()
    expect(clampPayload({ ...raw, computedStyles: null })).toBeNull()
  })

  it('tolerates optional fields being absent or the wrong type', () => {
    const out = clampPayload({ ...raw, reactComponents: undefined, sourceFile: 5, nearbyText: 'nope', accessibility: null })!
    expect(out.reactComponents).toBeNull()
    expect(out.sourceFile).toBeNull()
    expect(out.nearbyText).toEqual([])
    expect(out.accessibility).toEqual({ role: null, accessibleName: null })
  })
})

describe('isSecretName', () => {
  it.each(['token', 'data-token', 'Authorization', 'x-api-key', 'apiKey', 'password', 'passwd', 'secret', 'cookie', 'session', 'csrf'])(
    '%s is secret', (n) => expect(isSecretName(n)).toBe(true)
  )
  it.each(['id', 'class', 'title', 'href', 'data-testid', 'aria-label'])('%s is not', (n) => expect(isSecretName(n)).toBe(false))
})

describe('sanitizeUrl', () => {
  it('strips sensitive params and keeps the rest in order', () => {
    expect(sanitizeUrl('https://a.b/c?x=1&access_token=t&y=2')).toBe('https://a.b/c?x=1&y=2')
  })
  it('empty for non-web schemes and garbage', () => {
    expect(sanitizeUrl('ftp://a')).toBe('')
    expect(sanitizeUrl('nope')).toBe('')
  })
})
