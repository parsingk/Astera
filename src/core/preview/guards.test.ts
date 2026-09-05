import { describe, it, expect } from 'vitest'
import {
  PREVIEW_PARTITION,
  certificateAllowed,
  guestAttachAllowed,
  guestNavigationAllowed,
  permissionAllowed
} from './guards'

describe('guestAttachAllowed', () => {
  it('needs the preview partition and a web (or blank) src', () => {
    expect(guestAttachAllowed({ src: 'http://localhost:5173/', partition: PREVIEW_PARTITION })).toBe(true)
    expect(guestAttachAllowed({ src: 'https://app.localhost/', partition: PREVIEW_PARTITION })).toBe(true)
    expect(guestAttachAllowed({ src: 'about:blank', partition: PREVIEW_PARTITION })).toBe(true)
    expect(guestAttachAllowed({ src: '', partition: PREVIEW_PARTITION })).toBe(true)
    expect(guestAttachAllowed({ partition: PREVIEW_PARTITION })).toBe(true)
  })
  it('refuses another partition, no partition, and non-web schemes', () => {
    expect(guestAttachAllowed({ src: 'http://localhost:5173/', partition: 'persist:other' })).toBe(false)
    expect(guestAttachAllowed({ src: 'http://localhost:5173/' })).toBe(false)
    expect(guestAttachAllowed({ src: 'file:///C:/secrets.txt', partition: PREVIEW_PARTITION })).toBe(false)
    expect(guestAttachAllowed({ src: 'javascript:alert(1)', partition: PREVIEW_PARTITION })).toBe(false)
  })
})

describe('guestNavigationAllowed', () => {
  it('http and https only', () => {
    expect(guestNavigationAllowed('http://localhost:5173/x')).toBe(true)
    expect(guestNavigationAllowed('https://accounts.google.com/o/oauth2')).toBe(true)
    expect(guestNavigationAllowed('file:///etc/passwd')).toBe(false)
    expect(guestNavigationAllowed('chrome://settings')).toBe(false)
    expect(guestNavigationAllowed('not a url')).toBe(false)
  })
})

describe('permissionAllowed', () => {
  it('loopback origins may ask; the rest are refused', () => {
    expect(permissionAllowed('http://localhost:5173/')).toBe(true)
    expect(permissionAllowed('https://example.com/')).toBe(false)
  })
})

describe('certificateAllowed', () => {
  it('only a preview guest, and only for a loopback address', () => {
    expect(certificateAllowed('https://localhost:8443/', 'webview')).toBe(true)
    expect(certificateAllowed('https://localhost:8443/', 'window')).toBe(false)
    expect(certificateAllowed('https://example.com/', 'webview')).toBe(false)
  })
})
