import { describe, it, expect } from 'vitest'
import { clampPayload, containsSecret, isSecretName, isSecretValue, sanitizeUrl } from './payload'
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

  it('caps nearbyText entries and their length', () => {
    const many = Array.from({ length: 30 }, (_, i) => `t${i}` + 'y'.repeat(500))
    const out = clampPayload({ ...raw, nearbyText: many })!
    expect(out.nearbyText).toHaveLength(PICK_BUDGET.nearbyTextEntries)
    expect(out.nearbyText[0]).toHaveLength(PICK_BUDGET.nearbyTextEntry)
  })

  it('redacts secret-looking attributes inside the HTML, keeping the name so the agent sees it exists', () => {
    const html = '<div data-token="abc" Authorization="Bearer x" title="fine" data-hash="' + 'a'.repeat(40) + '"></div>'
    const out = clampPayload({ ...raw, htmlSnippet: html })!.htmlSnippet
    expect(out).toContain('data-token="[redacted]"')
    expect(out).toContain('Authorization="[redacted]"')
    expect(out).toContain('data-hash="[redacted]"')
    expect(out).toContain('title="fine"')
  })

  // outerHTML carries every descendant too, which is where a page keeps the things worth stealing
  it('redacts a descendant’s hidden field and empties a script body', () => {
    const html = '<div><input type="hidden" name="csrf" value="8a3f"><script id="__NEXT_DATA__">{"apiKey":"AIzaSyDEADBEEF"}</script></div>'
    const out = clampPayload({ ...raw, htmlSnippet: html })!.htmlSnippet
    expect(out).not.toContain('AIzaSyDEADBEEF')
    expect(out).toContain('<script id="__NEXT_DATA__">[redacted]</script>')
    expect(out).not.toContain('8a3f')
    expect(out).toContain('value="[redacted]"')
    // the name stays: it tells the agent what the field is, and it is not the secret
    expect(out).toContain('name="csrf"')
  })

  it('a tag name keeps only what a tag name can hold', () => {
    expect(clampPayload({ ...raw, tagName: 'DIV' })!.tagName).toBe('div')
    expect(clampPayload({ ...raw, tagName: 'div\n\n## heading' })!.tagName).toBe('divheading')
    expect(clampPayload({ ...raw, tagName: 'my-widget' })!.tagName).toBe('my-widget')
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

describe('the three ways a secret nearly got through', () => {
  // Found by review, all in the same trust boundary. Each of these passed before the fix.
  it('strips credentials written into the URL', () => {
    expect(sanitizeUrl('https://admin:hunter2@internal.corp/dashboard')).toBe('https://internal.corp/dashboard')
    expect(clampPayload({ ...raw, page: { ...raw.page, url: 'http://u:p@localhost:5173/a' } })!.page.url).toBe('http://localhost:5173/a')
  })

  it('drops a query parameter whose value looks like a secret, whatever it is called', () => {
    expect(sanitizeUrl('https://a.b/c?ref=' + 'ab'.repeat(20) + '&page=2')).toBe('https://a.b/c?page=2')
  })

  it('redacts a dotted secret — a JWT is three base64url segments, which no single run matches', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(isSecretValue(jwt)).toBe(true)
    expect(clampPayload({ ...raw, htmlSnippet: `<a data-jwt="${jwt}"></a>` })!.htmlSnippet).toContain('data-jwt="[redacted]"')
    expect(clampPayload({ ...raw, htmlSnippet: '<a data-bearer="x"></a>' })!.htmlSnippet).toContain('data-bearer="[redacted]"')
  })

  it('leaves ordinary dotted values alone', () => {
    for (const v of ['1.2.3', 'foo.bar.com', 'a.b.c', 'module.exports.default'])
      expect(isSecretValue(v), v).toBe(false)
  })
})

describe('the two ways a secret still got out of the HTML', () => {
  // Both found by review, both reachable from a page that tampers with the picker.
  it('an unquoted attribute value is redacted like a quoted one', () => {
    const out = clampPayload({ ...raw, htmlSnippet: '<div data-token=AKIAIOSFODNN7EXAMPLE1 class=card></div>' })!.htmlSnippet
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE1')
    expect(out).toContain('data-token="[redacted]"')
    expect(out).toContain('class=card')
  })

  it('an unquoted hidden input loses its value', () => {
    const out = clampPayload({ ...raw, htmlSnippet: '<input type=hidden name=csrf value=8a3f9b2c>' })!.htmlSnippet
    expect(out).not.toContain('8a3f9b2c')
    expect(out).toContain('value="[redacted]"')
  })

  it('a key buried inside a larger value goes too', () => {
    const html = '<div data-config=\'{"apiKey":"AIzaSyDEADBEEF1234567890","other":"fine"}\'></div>'
    const out = clampPayload({ ...raw, htmlSnippet: html })!.htmlSnippet
    expect(out).not.toContain('AIzaSyDEADBEEF1234567890')
    expect(out).toContain('data-config="[redacted]"')
  })

  it('and out of a query parameter, wherever in the value it sits', () => {
    expect(sanitizeUrl('https://a.b/c?config={"k":"AIzaSyDEADBEEF1234567890"}&page=2')).toBe('https://a.b/c?page=2')
  })
})

describe('the way a secret got past the HTML rules entirely', () => {
  // Found in the dev app, not by review: every attribute of the demo page was redacted, and the same
  // key arrived anyway as prose. `innerText` is empty for a <script>, so the guest's collector fell
  // through to `textContent` and read the bootstrap JSON — under all three annotations of one batch.
  const NEXT_DATA = '{"props":{"secretKey":"AIzaSyTOPSECRET0987654321"}}'

  it('drops a nearby-text entry carrying a key, and keeps the ones beside it', () => {
    const out = clampPayload({ ...raw, nearbyText: ['Pricing', NEXT_DATA, 'Save changes'] })!
    expect(out.nearbyText).toEqual(['Pricing', 'Save changes'])
  })

  it('drops before capping the count, so a leak does not cost a slot', () => {
    const many = [NEXT_DATA, ...Array.from({ length: PICK_BUDGET.nearbyTextEntries }, (_, i) => `t${i}`)]
    const out = clampPayload({ ...raw, nearbyText: many })!
    expect(out.nearbyText).toHaveLength(PICK_BUDGET.nearbyTextEntries)
    expect(out.nearbyText.join(' ')).not.toContain('AIzaSy')
  })

  it('redacts the element’s own text when that is where the key is', () => {
    expect(clampPayload({ ...raw, textSnippet: NEXT_DATA })!.textSnippet).toBe('[redacted]')
    expect(clampPayload({ ...raw, textSnippet: 'Save changes to your plan' })!.textSnippet).toBe('Save changes to your plan')
  })
})

describe('containsSecret does not swallow ordinary text', () => {
  it.each([
    'some-really-long-descriptive-class-name',
    'a sentence that happens to be quite long indeed',
    'btn btn-primary btn-large is-active',
    '1.2.3',
    'https://example.com/docs/getting-started'
  ])('%s is left alone', (v) => expect(containsSecret(v)).toBe(false))

  it.each([
    'AIzaSyDEADBEEF1234567890',
    'ab'.repeat(20),
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  ])('%s is a secret', (v) => expect(containsSecret(v)).toBe(true))
})
