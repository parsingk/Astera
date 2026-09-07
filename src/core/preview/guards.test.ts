import { describe, it, expect } from 'vitest'
import {
  PREVIEW_PARTITION,
  agentNavigationAllowed,
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

describe('agentNavigationAllowed', () => {
  it('holds an agent guest to this machine', () => {
    expect(agentNavigationAllowed('http://localhost:5173/x', true)).toBe(true)
    expect(agentNavigationAllowed('https://example.com/', true)).toBe(false)
  })
  it('leaves every other guest on the wider http(s) rule', () => {
    expect(agentNavigationAllowed('https://example.com/', false)).toBe(true)
    expect(agentNavigationAllowed('file:///C:/x', false)).toBe(false)
  })
  // This is the promise the whole agent browser rests on: a script an agent writes can only ever point
  // its tab at this machine. The hosts below are the ones that read as loopback and are not.
  it('is not fooled by a host that only looks like this machine', () => {
    for (const u of [
      'http://localhost.example.com/',
      'http://127.0.0.1.attacker.com/',
      'http://localhost@evil.com/',
      'https://notlocalhost/',
      'file:///C:/x',
      'data:text/html,x',
      'javascript:alert(1)',
      'about:blank'
    ]) {
      expect(agentNavigationAllowed(u, true), u).toBe(false)
    }
  })
  it('accepts the other spellings of this machine', () => {
    for (const u of ['http://127.0.0.1:3000/', 'http://[::1]:5173/', 'HTTP://LOCALHOST:5173/', 'http://app.localhost/']) {
      expect(agentNavigationAllowed(u, true), u).toBe(true)
    }
  })
})
