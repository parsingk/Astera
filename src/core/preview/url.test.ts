import { describe, it, expect } from 'vitest'
import { displayHostOf, isHttpUrl, isLoopbackUrl, linkDestination, normalizeUrl, previewTargetOf } from './url'

describe('normalizeUrl', () => {
  it('canonicalises: trailing slash, lowercase host', () => {
    expect(normalizeUrl('http://LOCALHOST:5173')).toBe('http://localhost:5173/')
    expect(normalizeUrl('http://localhost:5173/app?x=1')).toBe('http://localhost:5173/app?x=1')
  })
  it('null for anything that is not a URL', () => {
    expect(normalizeUrl('not a url')).toBeNull()
    expect(normalizeUrl('')).toBeNull()
  })
  // `localhost:5173` *is* a URL to the parser (scheme "localhost", path "5173") — normalizeUrl keeps
  // it; isHttpUrl is what says it is not a page. The address bar adds http:// before normalising.
  it('a bare host:port parses as a scheme and is kept as such', () => {
    expect(normalizeUrl('localhost:5173')).toBe('localhost:5173')
  })
})

describe('isHttpUrl', () => {
  it('http and https only, and it must parse', () => {
    expect(isHttpUrl('http://localhost:5173')).toBe(true)
    expect(isHttpUrl('https://app.localhost/')).toBe(true)
    expect(isHttpUrl('ftp://x')).toBe(false)
    expect(isHttpUrl('localhost:5173')).toBe(false)
    expect(isHttpUrl(' ')).toBe(false)
    expect(isHttpUrl('')).toBe(false)
  })
})

describe('isLoopbackUrl', () => {
  it.each([
    'http://localhost',
    'http://LOCALHOST:5173/',
    'https://app.localhost/login',
    'http://127.0.0.1:3000',
    'http://127.5.5.5',
    'http://[::1]:8080/x',
    'http://0.0.0.0:5173',
    'http://[::]:3000'
  ])('%s is this machine', (u) => expect(isLoopbackUrl(u)).toBe(true))

  it.each([
    'http://example.com',
    'http://192.168.1.5:3000',
    'http://10.0.0.1',
    'ftp://localhost',
    'http://localhost.example.com',
    'http://127.0.0.1.evil.com',
    'garbage',
    ''
  ])('%s is not', (u) => expect(isLoopbackUrl(u)).toBe(false))
})

describe('previewTargetOf', () => {
  it('rewrites the every-interface addresses to localhost', () => {
    expect(previewTargetOf('http://0.0.0.0:5173/app')).toBe('http://localhost:5173/app')
    expect(previewTargetOf('http://[::]:3000/')).toBe('http://localhost:3000/')
  })
  it('returns everything else byte for byte', () => {
    expect(previewTargetOf('http://localhost:5173')).toBe('http://localhost:5173')
    expect(previewTargetOf('http://127.0.0.1:3000/x?y=1')).toBe('http://127.0.0.1:3000/x?y=1')
    expect(previewTargetOf('not a url')).toBe('not a url')
  })
})

describe('linkDestination', () => {
  it('loopback → preview, others → external; the modifier inverts', () => {
    expect(linkDestination('http://localhost:5173', { modifier: false })).toBe('preview')
    expect(linkDestination('http://localhost:5173', { modifier: true })).toBe('external')
    expect(linkDestination('https://github.com', { modifier: false })).toBe('external')
    expect(linkDestination('https://github.com', { modifier: true })).toBe('preview')
  })
})

describe('displayHostOf', () => {
  it('host with port, host alone, and the input when it does not parse', () => {
    expect(displayHostOf('http://localhost:5173/app')).toBe('localhost:5173')
    expect(displayHostOf('https://app.localhost/')).toBe('app.localhost')
    expect(displayHostOf('nope')).toBe('nope')
  })
})
