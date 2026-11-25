// The packaged renderer's content security policy (electron.vite.csp.ts): put into the built index.html only, since
// Vite's dev server needs inline scripts and its socket. Spec E3 and the Phase 0 audit section 5, item 3.
import { describe, it, expect } from 'vitest'
import config from './electron.vite.config'
import { RENDERER_CSP, cspPlugin, withCsp } from './electron.vite.csp'
import { MEDIA_SCHEME } from './src/core/files/media'

const directives = Object.fromEntries(
  RENDERER_CSP.split(';').map((d) => {
    const [name, ...values] = d.trim().split(/\s+/)
    return [name, values]
  })
)

describe('the renderer CSP', () => {
  it('runs only the app’s own scripts and lets no plugin object, base or form in', () => {
    expect(directives['default-src']).toEqual(["'self'"])
    expect(directives['script-src']).toEqual(["'self'"])
    expect(directives['object-src']).toEqual(["'none'"])
    expect(directives['base-uri']).toEqual(["'none'"])
    expect(directives['form-action']).toEqual(["'none'"])
    expect(RENDERER_CSP).not.toContain('unsafe-eval')
  })

  // What the renderer shows today keeps showing: remote markdown images, data: and blob: frames and attachments, the media viewer
  it('allows the images, media and styles the renderer uses', () => {
    expect(directives['img-src']).toEqual(["'self'", 'data:', 'blob:', 'https:', 'http:', `${MEDIA_SCHEME}:`])
    expect(directives['media-src']).toEqual(["'self'", 'blob:', `${MEDIA_SCHEME}:`])
    // CodeMirror and xterm put <style> elements in the page
    expect(directives['style-src']).toEqual(["'self'", "'unsafe-inline'"])
    expect(directives['font-src']).toEqual(["'self'", 'data:'])
    // A chat image is copied by fetching its src (assistant-ui image.tsx)
    expect(directives['connect-src']).toEqual(["'self'", 'data:', 'blob:', 'https:', 'http:'])
  })

  it('goes into the head of the built page as one meta tag', () => {
    const html = withCsp('<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n  </head>\n  <body></body>\n</html>\n')
    expect(html.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1)
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${RENDERER_CSP}" />`)
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('</head>'))
    expect(html.indexOf('Content-Security-Policy')).toBeGreaterThan(html.indexOf('<meta charset'))
  })

  it('applies to the build only, and is one of the renderer build’s plugins', () => {
    expect(cspPlugin().apply).toBe('build')
    const plugins = (config as { renderer: { plugins: { name: string }[] } }).renderer.plugins
    expect(plugins.some((p) => p.name === 'astera-renderer-csp')).toBe(true)
  })
})
