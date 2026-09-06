import { describe, it, expect } from 'vitest'
import { firstLoopbackUrl } from './consoleLinks'

describe('firstLoopbackUrl', () => {
  it('finds the address a dev server prints, banner framing and all', () => {
    const vite = ['', '  VITE v5.4.2  ready in 312 ms', '', '  ➜  Local:   http://localhost:5173/', '  ➜  Network: use --host to expose'].join('\n')
    expect(firstLoopbackUrl(vite)).toBe('http://localhost:5173/')
  })

  it('takes the first loopback one, not a remote address printed before it', () => {
    const out = 'fetching https://registry.npmjs.org/pkg\nserver at http://127.0.0.1:3000/'
    expect(firstLoopbackUrl(out)).toBe('http://127.0.0.1:3000/')
  })

  it('rewrites the addresses a browser cannot navigate to', () => {
    expect(firstLoopbackUrl('listening on http://0.0.0.0:8080/')).toBe('http://localhost:8080/')
  })

  it('peels the punctuation a sentence leaves on the end', () => {
    expect(firstLoopbackUrl('open http://localhost:4321/, then edit.')).toBe('http://localhost:4321/')
  })

  it('reads a URL framed by a TUI box', () => {
    expect(firstLoopbackUrl('  │  Local:   http://localhost:4321/  │')).toBe('http://localhost:4321/')
  })

  it('null when the output has no address of ours', () => {
    expect(firstLoopbackUrl('')).toBeNull()
    expect(firstLoopbackUrl('build finished in 2.1s')).toBeNull()
    expect(firstLoopbackUrl('see https://example.com/docs for help')).toBeNull()
  })

  it('is not left mid-string by the previous call — the regex is global', () => {
    const text = 'up at http://localhost:5173/'
    expect(firstLoopbackUrl(text)).toBe('http://localhost:5173/')
    expect(firstLoopbackUrl(text)).toBe('http://localhost:5173/')
  })
})
