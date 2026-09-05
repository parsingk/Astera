// Electron's <webview> is not a React intrinsic element. This tells JSX what it is and what it
// accepts; the element's methods and events come from Electron's WebviewTag type (a type-only import,
// erased at build time — the renderer never loads the electron module).
import type { WebviewTag } from 'electron'
import type { DetailedHTMLProps, HTMLAttributes } from 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<WebviewTag>, WebviewTag> & {
        src?: string
        partition?: string
      }
    }
  }
}

export {}
