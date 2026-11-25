// The packaged renderer's content security policy (spec E3, the Phase 0 audit section 5 item 3). Only Astera's own scripts
// run in the main window: a script injected through a rendered file, a markdown preview or a plugin later finds no
// source it may load from. It goes into the built index.html as a meta tag, because the production page is a file://
// document, which carries no response headers, and only into the build, because Vite's dev server needs inline scripts
// and its own socket.
//
// What the renderer shows today keeps showing: remote markdown images (the person kept them, as GitHub and VS Code show
// them), data: and blob: images (the app mirror's frames, chat attachments, local markdown images), the media viewer's
// astera-media: scheme (main/index.ts registers it without bypassCSP so that it is named here). Styles allow inline,
// since CodeMirror and xterm put <style> elements in the page.
import type { Plugin } from 'vite'

export const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http: astera-media:",
  "media-src 'self' blob: astera-media:",
  "font-src 'self' data:",
  // A chat image is copied to the clipboard by fetching its src (assistant-ui image.tsx)
  "connect-src 'self' data: blob: https: http:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

/** The page with the policy as the first thing after its charset, so it governs everything the head loads. */
export function withCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${RENDERER_CSP}" />`
  const charset = html.match(/<meta charset="[^"]*"\s*\/?>/i)
  if (charset?.index !== undefined) {
    const at = charset.index + charset[0].length
    return `${html.slice(0, at)}\n    ${meta}${html.slice(at)}`
  }
  return html.replace(/<head>/i, `<head>\n    ${meta}`)
}

/** Puts the policy into the built renderer page; the dev server is left as it is. */
export function cspPlugin(): Plugin {
  return {
    name: 'astera-renderer-csp',
    apply: 'build',
    transformIndexHtml: (html) => withCsp(html)
  }
}
